'use strict'

const fs = require('fs')
const path = require('path')
const recast = require('recast')
const b = recast.types.builders
const CONFIG = require('../config')

module.exports = function () {
  const modulesUnsupportedByMkSnapshot = new Set([
    'child_process',
    'crypto',
    'electron',
    'fs',
    'path'
  ])
  const filePath = path.join(CONFIG.intermediateAppPath, 'src', 'atom-environment.js')
  // const filePath = path.join(CONFIG.intermediateAppPath, 'src', 'buffered-process.js')
  const fileContents = fs.readFileSync(filePath, 'utf8')
  const ast = recast.parse(fileContents)
  const programHasClosureWrapper =
    ast.program.body.length === 1 &&
    ast.program.body[0].type === 'ExpressionStatement' &&
    ast.program.body[0].expression.type === 'CallExpression' &&
    ast.program.body[0].expression.arguments[0].type === 'ThisExpression' &&
    ast.program.body[0].expression.callee.object.type === 'FunctionExpression'
  const lazyRequireFunctionsByVariableName = new Map()

  function isTopLevelPath (path) {
    return path.scope.isGlobal || (programHasClosureWrapper && path.scope.depth === 1)
  }

  function isUnsupportedModuleRequire (path) {
    const node = path.node
    return (
      node.callee.name === 'require' &&
      node.arguments.length === 1 &&
      node.arguments[0].type === 'Literal' &&
      modulesUnsupportedByMkSnapshot.has(node.arguments[0].value)
    )
  }

  function isReferenced (node, parent) {
    switch (parent.type) {
      // yes: object::NODE
      // yes: NODE::callee
      case "BindExpression":
        return parent.object === node || parent.callee === node;

      // yes: PARENT[NODE]
      // yes: NODE.child
      // no: parent.NODE
      case "MemberExpression":
      case "JSXMemberExpression":
        if (parent.property === node && parent.computed) {
          return true;
        } else if (parent.object === node) {
          return true;
        } else {
          return false;
        }

      // no: new.NODE
      // no: NODE.target
      case "MetaProperty":
        return false;

      // yes: { [NODE]: "" }
      // yes: { NODE }
      // no: { NODE: "" }
      case "ObjectProperty":
        if (parent.key === node) {
          return parent.computed;
        }

      // no: let NODE = init;
      // yes: let id = NODE;
      case "VariableDeclarator":
        return parent.id !== node;

      // no: function NODE() {}
      // no: function foo(NODE) {}
      case "ArrowFunctionExpression":
      case "FunctionDeclaration":
      case "FunctionExpression":
        for (let param of parent.params) {
          if (param === node) return false;
        }

        return parent.id !== node;

      // no: export { foo as NODE };
      // yes: export { NODE as foo };
      // no: export { NODE as foo } from "foo";
      case "ExportSpecifier":
        if (parent.source) {
          return false;
        } else {
          return parent.local === node;
        }

      // no: export NODE from "foo";
      // no: export * as NODE from "foo";
      case "ExportNamespaceSpecifier":
      case "ExportDefaultSpecifier":
        return false;

      // no: <div NODE="foo" />
      case "JSXAttribute":
        return parent.name !== node;

      // no: class { NODE = value; }
      // yes: class { [NODE] = value; }
      // yes: class { key = NODE; }
      case "ClassProperty":
        if (parent.key === node) {
          return parent.computed;
        } else {
          return parent.value === node;
        }

      // no: import NODE from "foo";
      // no: import * as NODE from "foo";
      // no: import { NODE as foo } from "foo";
      // no: import { foo as NODE } from "foo";
      // no: import NODE from "bar";
      case "ImportDefaultSpecifier":
      case "ImportNamespaceSpecifier":
      case "ImportSpecifier":
        return false;

      // no: class NODE {}
      case "ClassDeclaration":
      case "ClassExpression":
        return parent.id !== node;

      // yes: class { [NODE]() {} }
      case "ClassMethod":
      case "ObjectMethod":
        return parent.key === node && parent.computed;

      // no: NODE: for (;;) {}
      case "LabeledStatement":
        return false;

      // no: try {} catch (NODE) {}
      case "CatchClause":
        return parent.param !== node;

      // no: function foo(...NODE) {}
      case "RestElement":
        return false;

      // yes: left = NODE;
      // no: NODE = right;
      case "AssignmentExpression":
        return parent.right === node;

      // no: [NODE = foo] = [];
      // yes: [foo = NODE] = [];
      case "AssignmentPattern":
        return parent.right === node;

      // no: [NODE] = [];
      // no: ({ NODE }) = [];
      case "ObjectPattern":
      case "ArrayPattern":
        return false;
    }

    return true;
  }

  function isReferenceToLazyRequire (path) {
    const node = path.node
    const parent = path.parent.node
    const lazyRequireFunctionName = lazyRequireFunctionsByVariableName.get(node.name)
    return (
      lazyRequireFunctionName != null &&
      (path.scope.node.type !== 'FunctionDeclaration' || lazyRequireFunctionName !== path.scope.node.id.name) &&
      isReferenced(node, parent)
    )
  }

  function replaceAssignmentOrDeclarationWithLazyFunction (path) {
    let parentPath = path.parent
    while (parentPath != null) {
      const parentNode = parentPath.node
      if (parentNode.type === 'AssignmentExpression') {
        const lazyRequireFunctionName = `get_${parentNode.left.name}`
        lazyRequireFunctionsByVariableName.set(parentNode.left.name, lazyRequireFunctionName)
        parentPath.replace(b.functionDeclaration(b.identifier(lazyRequireFunctionName), [], b.blockStatement([
          b.returnStatement(
            b.assignmentExpression('=', parentNode.left, b.logicalExpression('||', parentNode.left, parentNode.right))
          )
        ])))
        break
      } else if (parentNode.type === 'VariableDeclarator') {
        const lazyRequireFunctionName = `get_${parentNode.id.name}`
        const variableDeclarationPath = parentPath.parent
        const variableDeclarationNode = variableDeclarationPath.node
        if (variableDeclarationNode.kind === 'const') {
          variableDeclarationNode.kind = 'let'
        }
        lazyRequireFunctionsByVariableName.set(parentNode.id.name, lazyRequireFunctionName)
        parentPath.replace(b.variableDeclarator(parentNode.id, null))
        variableDeclarationPath.insertAfter(b.functionDeclaration(b.identifier(lazyRequireFunctionName), [], b.blockStatement([
          b.returnStatement(
            b.assignmentExpression('=', parentNode.id, b.logicalExpression('||', parentNode.id, parentNode.init))
          )
        ])))
        break
      }
      parentPath = parentPath.parent
    }

    if (parentPath == null) {
      throw new Error(`
        Using a blacklisted module for its side effects in this file's topmost scope.
        Consider moving it inside an initialization function to call at runtime.
      `)
    }
  }

  recast.types.visit(ast, {
    visitCallExpression: function (path) {
      if (isTopLevelPath(path) && isUnsupportedModuleRequire(path)) {
        replaceAssignmentOrDeclarationWithLazyFunction(path)
      }
      this.traverse(path);
    }
  })

  recast.types.visit(ast, {
    visitIdentifier: function (path) {
      if (isTopLevelPath(path) && isReferenceToLazyRequire(path)) {
        path.replace(b.callExpression(b.identifier(lazyRequireFunctionsByVariableName.get(path.node.name)), []))
        replaceAssignmentOrDeclarationWithLazyFunction(path)
      }
      this.traverse(path)
    }
  })

  recast.types.visit(ast, {
    visitIdentifier: function (path) {
      if (!isTopLevelPath(path) && isReferenceToLazyRequire(path)) {
        path.replace(b.callExpression(b.identifier(lazyRequireFunctionsByVariableName.get(path.node.name)), []))
      }
      this.traverse(path)
    }
  })

  // console.log(lazyRequireFunctionsByVariableName);
  console.log(recast.print(ast).code);
}

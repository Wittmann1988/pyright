/*
* binder.ts
* Copyright (c) Microsoft Corporation.
* Licensed under the MIT license.
* Author: Eric Traut
*
* A parse tree walker that performs basic name binding (creation of
* scopes and associated symbol tables).
* The binder walks the parse tree by scopes starting at the module
* level. When a new scope is detected, it is pushed onto a list and
* walked separately at a later time. (The exception is a class scope,
* which is immediately walked.) Walking the tree in this manner
* simulates the order in which execution normally occurs in a Python
* file. The binder attempts to statically detect runtime errors that
* would be reported by the python interpreter when executing the code.
* This binder doesn't perform any static type checking.
*/

import * as assert from 'assert';

import { DiagnosticLevel } from '../common/configOptions';
import { CreateTypeStubFileAction, getEmptyRange } from '../common/diagnostic';
import { DiagnosticRule } from '../common/diagnosticRules';
import { convertOffsetsToRange } from '../common/positionUtils';
import { PythonVersion } from '../common/pythonVersion';
import StringMap from '../common/stringMap';
import { TextRange } from '../common/textRange';
import { AssignmentExpressionNode, AssignmentNode, AugmentedAssignmentExpressionNode,
    AwaitExpressionNode, ClassNode, DelNode, ExceptNode, ExpressionNode, ForNode,
    FunctionNode, GlobalNode, IfNode, ImportAsNode, ImportFromNode, LambdaNode,
    ListComprehensionNode, MemberAccessExpressionNode, ModuleNameNode, ModuleNode, NameNode,
    NonlocalNode, ParseNode, ParseNodeType, RaiseNode, StatementNode,
    StringListNode, SuiteNode, TryNode, TypeAnnotationExpressionNode, WhileNode,
    WithNode, YieldExpressionNode, YieldFromExpressionNode } from '../parser/parseNodes';
import * as StringTokenUtils from '../parser/stringTokenUtils';
import { StringTokenFlags } from '../parser/tokenizerTypes';
import { AnalyzerFileInfo } from './analyzerFileInfo';
import * as AnalyzerNodeInfo from './analyzerNodeInfo';
import { AliasDeclaration, DeclarationType, ModuleLoaderActions,
    VariableDeclaration } from './declaration';
import * as DocStringUtils from './docStringUtils';
import { ImplicitImport, ImportResult, ImportType } from './importResult';
import { defaultTypeSourceId, TypeSourceId } from './inferredType';
import * as ParseTreeUtils from './parseTreeUtils';
import { ParseTreeWalker } from './parseTreeWalker';
import { Scope, ScopeType } from './scope';
import * as ScopeUtils from './scopeUtils';
import * as StaticExpressions from './staticExpressions';
import { SymbolFlags } from './symbol';
import { isConstantName } from './symbolNameUtils';
import { AnyType, ClassType, ClassTypeFlags, FunctionParameter, FunctionType,
    FunctionTypeFlags, Type, TypeCategory, UnknownType } from './types';

type ScopedNode = ModuleNode | ClassNode | FunctionNode | LambdaNode;

export const enum NameBindingType {
    // With "nonlocal" keyword
    Nonlocal,

    // With "global" keyword
    Global
}

interface MemberAccessInfo {
    classNode: ClassNode;
    methodNode: FunctionNode;
    classScope: Scope;
    isInstanceMember: boolean;
}

export abstract class Binder extends ParseTreeWalker {
    protected readonly _scopedNode: ScopedNode;
    protected readonly _fileInfo: AnalyzerFileInfo;

    // A queue of scoped nodes that need to be analyzed.
    protected _subscopesToAnalyze: Binder[] = [];

    // The current scope in effect. This is either the base scope or a
    // "temporary scope", used for analyzing conditional code blocks. Their
    // contents are eventually merged in to the base scope.
    protected _currentScope: Scope;

    // Number of nested except statements at current point of analysis.
    // Used to determine if a naked "raise" statement is allowed.
    private _nestedExceptDepth = 0;

    // Indicates that any name that's encountered should be ignored
    // because it's in an unexecuted section of code.
    protected _isUnexecutedCode = false;

    // Name bindings that are not local to the current scope.
    protected _notLocalBindings = new StringMap<NameBindingType>();

    constructor(node: ScopedNode, scopeType: ScopeType, parentScope: Scope | undefined,
            fileInfo: AnalyzerFileInfo) {

        super();

        this._scopedNode = node;
        this._fileInfo = fileInfo;

        // Allocate a new scope and associate it with the node
        // we've been asked to analyze.
        this._currentScope = new Scope(scopeType, parentScope);

        // If this is the built-in scope, we need to hide symbols
        // that are in the stub file but are not officially part of
        // the built-in list of symbols in Python.
        if (scopeType === ScopeType.Builtin) {
            const builtinsToExport = [
                'ArithmeticError', 'AssertionError', 'AttributeError', 'BaseException',
                'BlockingIOError', 'BrokenPipeError', 'BufferError', 'BytesWarning',
                'ChildProcessError', 'ConnectionAbortedError', 'ConnectionError',
                'ConnectionRefusedError', 'ConnectionResetError', 'DeprecationWarning',
                'EOFError', 'Ellipsis', 'EnvironmentError', 'Exception',
                'FileExistsError', 'FileNotFoundError', 'FloatingPointError',
                'FutureWarning', 'GeneratorExit', 'IOError', 'ImportError',
                'ImportWarning', 'IndentationError', 'IndexError', 'InterruptedError',
                'IsADirectoryError', 'KeyError', 'KeyboardInterrupt', 'LookupError',
                'MemoryError', 'NameError', 'NotADirectoryError', 'NotImplemented',
                'NotImplementedError', 'OSError', 'OverflowError', 'PendingDeprecationWarning',
                'PermissionError', 'ProcessLookupError', 'RecursionError', 'ReferenceError',
                'ResourceWarning', 'RuntimeError', 'RuntimeWarning', 'StopAsyncIteration',
                'StopIteration', 'SyntaxError', 'SyntaxWarning', 'SystemError', 'SystemExit',
                'TabError', 'TimeoutError', 'TypeError', 'UnboundLocalError',
                'UnicodeDecodeError', 'UnicodeEncodeError', 'UnicodeError', 'UnicodeTranslateError',
                'UnicodeWarning', 'UserWarning', 'ValueError', 'Warning', 'WindowsError',
                'ZeroDivisionError',
                '__import__', '__loader__', '__name__',
                '__package__', '__spec__', 'abs', 'all', 'any', 'ascii', 'bin', 'bool', 'breakpoint',
                'bytearray', 'bytes', 'callable', 'chr', 'classmethod', 'compile', 'complex',
                'copyright', 'credits', 'delattr', 'dict', 'dir', 'divmod', 'enumerate', 'eval',
                'exec', 'exit', 'filter', 'float', 'format', 'frozenset', 'getattr', 'globals',
                'hasattr', 'hash', 'help', 'hex', 'id', 'input', 'int', 'isinstance',
                'issubclass', 'iter', 'len', 'license', 'list', 'locals', 'map', 'max',
                'memoryview', 'min', 'next', 'object', 'oct', 'open', 'ord', 'pow', 'print',
                'property', 'quit', 'range', 'repr', 'reversed', 'round', 'set', 'setattr',
                'slice', 'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple', 'type',
                'vars', 'zip'];

            this._currentScope.setExportFilter(builtinsToExport);
        }

        AnalyzerNodeInfo.setScope(this._scopedNode, this._currentScope);
    }

    // We separate binding into two passes. The first happens immediately when
    // the scope analyzer is created. The second happens after its parent scope
    // has been fully analyzed.
    bindDeferred() {
        // Analyze any sub-scopes that were discovered during the earlier pass.
        this._analyzeSubscopesDeferred();
    }

    visitModule(node: ModuleNode): boolean {
        // Tree walking should start with the children of
        // the node, so we should never get here.
        assert.fail('We should never get here');
        return false;
    }

    visitModuleName(node: ModuleNameNode): boolean {
        const importResult = AnalyzerNodeInfo.getImportInfo(node);
        assert(importResult !== undefined);

        if (importResult && !this._isUnexecutedCode) {
            if (!importResult.isImportFound) {
                this._addDiagnostic(this._fileInfo.diagnosticSettings.reportMissingImports,
                    DiagnosticRule.reportMissingImports,
                    `Import '${ importResult.importName }' could not be resolved`, node);
            } else if (importResult.importType === ImportType.ThirdParty) {
                if (!importResult.isStubFile) {
                    const diagnostic = this._addDiagnostic(
                        this._fileInfo.diagnosticSettings.reportMissingTypeStubs,
                        DiagnosticRule.reportMissingTypeStubs,
                        `Stub file not found for '${ importResult.importName }'`, node);
                    if (diagnostic) {
                        // Add a diagnostic action for resolving this diagnostic.
                        const createTypeStubAction: CreateTypeStubFileAction = {
                            action: 'pyright.createtypestub',
                            moduleName: importResult.importName
                        };
                        diagnostic.addAction(createTypeStubAction);
                    }
                }
            }
        }

        return true;
    }

    visitClass(node: ClassNode): boolean {
        this.walkMultiple(node.decorators);

        let classFlags = ClassTypeFlags.None;
        if (this._currentScope.getType() === ScopeType.Builtin ||
                this._fileInfo.isTypingStubFile ||
                this._fileInfo.isBuiltInStubFile) {

            classFlags |= ClassTypeFlags.BuiltInClass;
        }

        const classType = ClassType.create(node.name.nameToken.value, classFlags,
            node.id, this._getDocString(node.suite.statements));

        const symbol = this._bindNameToScope(this._currentScope, node.name.nameToken.value);
        if (symbol) {
            if (!this._isUnexecutedCode) {
                symbol.addDeclaration({
                    type: DeclarationType.Class,
                    node,
                    path: this._fileInfo.filePath,
                    range: convertOffsetsToRange(node.name.start,
                        TextRange.getEnd(node.name), this._fileInfo.lines)
                });
            }
        }

        this.walkMultiple(node.arguments);

        let sawMetaclass = false;
        let nonMetaclassBaseClassCount = 0;
        node.arguments.forEach(arg => {
            let isKeywordArg = false;
            let isMetaclass = false;
            if (arg.name) {
                if (arg.name.nameToken.value === 'metaclass') {
                    if (sawMetaclass) {
                        this._addError(`Only one metaclass can be provided`, arg);
                    }
                    isMetaclass = true;
                    sawMetaclass = true;
                } else {
                    // Other named parameters are ignored here; they are passed
                    // directly to the metaclass.
                    isKeywordArg = true;
                }
            }

            if (!isKeywordArg) {
                ClassType.addBaseClass(classType, UnknownType.create(), isMetaclass);

                if (!isMetaclass) {
                    nonMetaclassBaseClassCount++;
                }
            }
        });

        if (nonMetaclassBaseClassCount === 0) {
            // Make sure we don't have 'object' derive from itself. Infinite
            // recursion will result.
            if (!ClassType.isBuiltIn(classType, 'object')) {
                const objectType = ScopeUtils.getBuiltInType(this._currentScope, 'object');
                ClassType.addBaseClass(classType, objectType, false);
            }
        }

        AnalyzerNodeInfo.setExpressionType(node, classType);

        // Also set the type of the name node. This will be replaced by the analyzer
        // once any class decorators are analyzed, but we need to add it here to
        // accommodate some circular references between builtins and typing type stubs.
        AnalyzerNodeInfo.setExpressionType(node.name, classType);

        const binder = new ClassScopeBinder(node, this._currentScope, classType, this._fileInfo);
        this._queueSubScopeAnalyzer(binder);

        // Add the class symbol. We do this in the binder to speed
        // up overall analysis times. Without this, the type analyzer needs
        // to do more passes to resolve classes.
        this._addSymbolToCurrentScope(node.name.nameToken.value, classType, node.name.id);

        return false;
    }

    visitFunction(node: FunctionNode): boolean {
        // The "__new__" magic method is not an instance method.
        // It acts as a static method instead.
        let functionFlags = FunctionTypeFlags.None;
        if (node.name.nameToken.value === '__new__') {
            functionFlags |= FunctionTypeFlags.StaticMethod;
            functionFlags |= FunctionTypeFlags.ConstructorMethod;
            functionFlags &= ~FunctionTypeFlags.InstanceMethod;
        }

        const functionType = FunctionType.create(functionFlags,
            this._getDocString(node.suite.statements));

        const symbol = this._bindNameToScope(this._currentScope, node.name.nameToken.value);
        if (symbol) {
            if (!this._isUnexecutedCode) {
                const containingClassNode = ParseTreeUtils.getEnclosingClass(node, true);
                const declarationType = containingClassNode ?
                    DeclarationType.Method : DeclarationType.Function;
                symbol.addDeclaration({
                    type: declarationType,
                    node,
                    path: this._fileInfo.filePath,
                    range: convertOffsetsToRange(node.name.start, TextRange.getEnd(node.name),
                        this._fileInfo.lines)
                });
            }
        }

        this.walkMultiple(node.decorators);
        node.parameters.forEach(param => {
            if (param.defaultValue) {
                this.walk(param.defaultValue);
            }

            const typeParam: FunctionParameter = {
                category: param.category,
                name: param.name ? param.name.nameToken.value : undefined,
                hasDefault: !!param.defaultValue,
                type: UnknownType.create()
            };

            FunctionType.addParameter(functionType, typeParam);

            if (param.typeAnnotation) {
                this.walk(param.typeAnnotation);
            }
        });

        if (node.returnTypeAnnotation) {
            this.walk(node.returnTypeAnnotation);
        }

        AnalyzerNodeInfo.setExpressionType(node, functionType);

        // Find the function or module that contains this function and use its scope.
        // We can't simply use this._currentScope because functions within a class use
        // the scope of the containing function or module when they execute.
        let functionOrModuleNode: ParseNode | undefined = node.parent;
        while (functionOrModuleNode) {
            if (functionOrModuleNode.nodeType === ParseNodeType.Module ||
                    functionOrModuleNode.nodeType === ParseNodeType.Function) {
                break;
            }

            functionOrModuleNode = functionOrModuleNode.parent;
        }
        assert(functionOrModuleNode !== undefined);

        const functionOrModuleScope = AnalyzerNodeInfo.getScope(functionOrModuleNode!);
        assert(functionOrModuleScope !== undefined);

        const binder = new FunctionScopeBinder(node, functionOrModuleScope!, this._fileInfo);
        this._queueSubScopeAnalyzer(binder);

        return false;
    }

    visitLambda(node: LambdaNode): boolean {
        // Analyze the parameter defaults in the context of the parent's scope
        // before we add any names from the function's scope.
        node.parameters.forEach(param => {
            if (param.defaultValue) {
                this.walk(param.defaultValue);
            }
        });

        const binder = new LambdaScopeBinder(node, this._currentScope, this._fileInfo);
        this._queueSubScopeAnalyzer(binder);

        return false;
    }

    visitAssignment(node: AssignmentNode) {
        if (!this._handleTypingStubAssignment(node)) {
            this._bindPossibleTupleNamedTarget(node.leftExpression);

            if (node.typeAnnotationComment) {
                this._addTypeDeclarationForVariable(node.leftExpression, node.typeAnnotationComment);
            }

            this._addInferredTypeAssignmentForVariable(node.leftExpression, node.rightExpression);
        }
        return true;
    }

    visitAssignmentExpression(node: AssignmentExpressionNode) {
        this._bindPossibleTupleNamedTarget(node.name);
        this._addInferredTypeAssignmentForVariable(node.name, node.rightExpression);
        return true;
    }

    visitAugmentedAssignment(node: AugmentedAssignmentExpressionNode) {
        this._bindPossibleTupleNamedTarget(node.leftExpression);
        this._addInferredTypeAssignmentForVariable(node.leftExpression, node.rightExpression);
        return true;
    }

    visitDel(node: DelNode) {
        node.expressions.forEach(expr => {
            this._bindPossibleTupleNamedTarget(expr);
        });
        return true;
    }

    visitTypeAnnotation(node: TypeAnnotationExpressionNode): boolean {
        this._bindPossibleTupleNamedTarget(node.valueExpression);
        this._addTypeDeclarationForVariable(node.valueExpression, node.typeAnnotation);
        return true;
    }

    visitFor(node: ForNode) {
        this._bindPossibleTupleNamedTarget(node.targetExpression);
        this._addInferredTypeAssignmentForVariable(node.targetExpression, node);
        return true;
    }

    visitYield(node: YieldExpressionNode): boolean {
        this._validateYieldUsage(node);
        return true;
    }

    visitYieldFrom(node: YieldFromExpressionNode): boolean {
        this._validateYieldUsage(node);
        return true;
    }

    visitIf(node: IfNode): boolean {
        this._handleIfWhileCommon(node.testExpression, node.ifSuite, node.elseSuite);
        return false;
    }

    visitWhile(node: WhileNode): boolean {
        this._handleIfWhileCommon(node.testExpression, node.whileSuite, node.elseSuite);
        return false;
    }

    visitExcept(node: ExceptNode): boolean {
        if (node.name) {
            const symbol = this._bindNameToScope(this._currentScope, node.name.nameToken.value);
            if (symbol) {
                const declaration: VariableDeclaration = {
                    type: DeclarationType.Variable,
                    node: node.name,
                    isConstant: isConstantName(node.name.nameToken.value),
                    path: this._fileInfo.filePath,
                    range: convertOffsetsToRange(node.name.start, TextRange.getEnd(node.name),
                        this._fileInfo.lines)
                };
                symbol.addDeclaration(declaration);
            }
        }

        return true;
    }

    visitRaise(node: RaiseNode): boolean {
        this._currentScope.setAlwaysRaises();

        if (!node.typeExpression && this._nestedExceptDepth === 0) {
            this._addError(
                `Raise requires parameter(s) when used outside of except clause `,
                node);
        }

        return true;
    }

    visitTry(node: TryNode): boolean {
        this.walk(node.trySuite);

        // Wrap the except clauses in a conditional scope
        // so we can throw away any names that are bound
        // in this scope.
        this._nestedExceptDepth++;
        node.exceptClauses.forEach(exceptNode => {
            this.walk(exceptNode);
        });
        this._nestedExceptDepth--;

        if (node.elseSuite) {
            this.walk(node.elseSuite);
        }

        if (node.finallySuite) {
            this.walk(node.finallySuite);
        }

        return false;
    }

    visitAwait(node: AwaitExpressionNode) {
        // Make sure this is within an async lambda or function.
        const enclosingFunction = ParseTreeUtils.getEnclosingFunction(node);
        if (enclosingFunction === undefined || !enclosingFunction.isAsync) {
            this._addError(`'await' allowed only within async function`, node);
        }

        return true;
    }

    visitStringList(node: StringListNode): boolean {
        for (const stringNode of node.strings) {
            if (stringNode.hasUnescapeErrors) {
                const unescapedResult = StringTokenUtils.getUnescapedString(stringNode.token);

                unescapedResult.unescapeErrors.forEach(error => {
                    const start = stringNode.token.start + stringNode.token.prefixLength +
                        stringNode.token.quoteMarkLength + error.offset;
                    const textRange = { start, length: error.length };

                    if (error.errorType === StringTokenUtils.UnescapeErrorType.InvalidEscapeSequence) {
                        this._addDiagnostic(
                            this._fileInfo.diagnosticSettings.reportInvalidStringEscapeSequence,
                            DiagnosticRule.reportInvalidStringEscapeSequence,
                            'Unsupported escape sequence in string literal', textRange);
                    } else if (error.errorType ===
                            StringTokenUtils.UnescapeErrorType.EscapeWithinFormatExpression) {

                        this._addError(
                            'Escape sequence (backslash) not allowed in expression portion of f-string',
                            textRange);
                    } else if (error.errorType ===
                            StringTokenUtils.UnescapeErrorType.SingleCloseBraceWithinFormatLiteral) {

                        this._addError(
                            'Single close brace not allowed within f-string literal; use double close brace',
                            textRange);
                    } else if (error.errorType ===
                            StringTokenUtils.UnescapeErrorType.UnterminatedFormatExpression) {

                        this._addError(
                            'Unterminated expression in f-string; missing close brace',
                            textRange);
                    }
                });
            }
        }

        return true;
    }

    visitGlobal(node: GlobalNode): boolean {
        const globalScope = this._currentScope.getGlobalScope();

        node.nameList.forEach(name => {
            const nameValue = name.nameToken.value;

            // Is the binding inconsistent?
            if (this._notLocalBindings.get(nameValue) === NameBindingType.Nonlocal) {
                this._addError(`'${ nameValue }' was already declared nonlocal`, name);
            }

            const valueWithScope = this._currentScope.lookUpSymbolRecursive(nameValue);

            // Was the name already assigned within this scope before it was declared global?
            if (valueWithScope && valueWithScope.scope === this._currentScope) {
                this._addError(`'${ nameValue }' is assigned before global declaration`, name);
            }

            // Add it to the global scope if it's not already added.
            this._bindNameToScope(globalScope, nameValue);

            if (this._currentScope !== globalScope) {
                this._notLocalBindings.set(nameValue, NameBindingType.Global);
            }
        });

        return true;
    }

    visitNonlocal(node: NonlocalNode): boolean {
        const globalScope = this._currentScope.getGlobalScope();

        if (this._currentScope === globalScope) {
            this._addError('Nonlocal declaration not allowed at module level', node);
        } else {
            node.nameList.forEach(name => {
                const nameValue = name.nameToken.value;

                // Is the binding inconsistent?
                if (this._notLocalBindings.get(nameValue) === NameBindingType.Global) {
                    this._addError(`'${ nameValue }' was already declared global`, name);
                }

                const valueWithScope = this._currentScope.lookUpSymbolRecursive(nameValue);

                // Was the name already assigned within this scope before it was declared nonlocal?
                if (valueWithScope && valueWithScope.scope === this._currentScope) {
                    this._addError(`'${ nameValue }' is assigned before nonlocal declaration`, name);
                } else if (!valueWithScope || valueWithScope.scope === globalScope) {
                    this._addError(`No binding for nonlocal '${ nameValue }' found`, name);
                }

                this._notLocalBindings.set(nameValue, NameBindingType.Nonlocal);
            });
        }

        return true;
    }

    visitImportAs(node: ImportAsNode): boolean {
        if (node.module.nameParts.length > 0) {
            const firstNamePartValue = node.module.nameParts[0].nameToken.value;

            let symbolName: string | undefined;
            if (node.alias) {
                // The symbol name is defined by the alias.
                symbolName = node.alias.nameToken.value;
            } else {
                // There was no alias, so we need to use the first element of
                // the name parts as the symbol.
                symbolName = firstNamePartValue;
            }

            const symbol = this._bindNameToScope(this._currentScope, symbolName);

            const importInfo = AnalyzerNodeInfo.getImportInfo(node.module);
            assert(importInfo !== undefined);

            if (importInfo && importInfo.isImportFound && importInfo.resolvedPaths.length > 0 && symbol) {
                // See if there's already a matching alias delaration for this import.
                // if so, we'll update it rather than creating a new one. This is required
                // to handle cases where multiple import statements target the same
                // starting symbol such as "import a.b.c" and "import a.d". In this case,
                // we'll build a single declaration that describes the combined actions
                // of both import statements, thus reflecting the behavior of the
                // python module loader.
                const existingDecl = symbol.getDeclarations().find(
                    decl => decl.type === DeclarationType.Alias &&
                    decl.firstNamePart === firstNamePartValue);

                const newDecl: AliasDeclaration = existingDecl as AliasDeclaration || {
                    type: DeclarationType.Alias,
                    path: '',
                    range: getEmptyRange(),
                    firstNamePart: firstNamePartValue,
                    implicitImports: new Map<string, ModuleLoaderActions>()
                };

                // Add the implicit imports for this module if it's the last
                // name part we're resolving.
                if (node.alias || node.module.nameParts.length === 1) {
                    newDecl.path = importInfo.resolvedPaths[importInfo.resolvedPaths.length - 1];
                    this._addImplicitImportsToLoaderActions(importInfo, newDecl);
                } else {
                    // Fill in the remaining name parts.
                    let curLoaderActions: ModuleLoaderActions = newDecl;

                    for (let i = 1; i < node.module.nameParts.length; i++) {
                        if (i >= importInfo.resolvedPaths.length) {
                            break;
                        }

                        const namePartValue = node.module.nameParts[i].nameToken.value;

                        // Is there an existing loader action for this name?
                        let loaderActions = curLoaderActions.implicitImports.get(namePartValue);
                        if (!loaderActions) {
                            // Allocate a new loader action.
                            loaderActions = {
                                path: '',
                                implicitImports: new Map<string, ModuleLoaderActions>()
                            };
                            curLoaderActions.implicitImports.set(namePartValue, loaderActions);
                        }

                        // If this is the last name part we're resolving, add in the
                        // implicit imports as well.
                        if (i === node.module.nameParts.length - 1) {
                            loaderActions.path = importInfo.resolvedPaths[i];
                            this._addImplicitImportsToLoaderActions(importInfo, loaderActions);
                        }

                        curLoaderActions = loaderActions;
                    }
                }

                if (!existingDecl) {
                    symbol.addDeclaration(newDecl);
                }
            }
        }

        return true;
    }

    visitImportFrom(node: ImportFromNode): boolean {
        const importInfo = AnalyzerNodeInfo.getImportInfo(node.module);

        let resolvedPath = '';
        if (importInfo && importInfo.isImportFound) {
            resolvedPath = importInfo.resolvedPaths[importInfo.resolvedPaths.length - 1];
        }

        if (node.isWildcardImport) {
            if (importInfo && importInfo.implicitImports) {
                const lookupInfo = this._fileInfo.importLookup(resolvedPath);
                if (lookupInfo) {
                    lookupInfo.symbolTable.forEach((_, name) => {
                        const symbol = this._bindNameToScope(this._currentScope, name);
                        if (symbol) {
                            const aliasDecl: AliasDeclaration = {
                                type: DeclarationType.Alias,
                                path: resolvedPath,
                                range: getEmptyRange(),
                                symbolName: name,
                                implicitImports: new Map<string, ModuleLoaderActions>()
                            };
                            symbol.addDeclaration(aliasDecl);
                        }
                    });
                }

                // Also add all of the implicitly-imported modules for
                // the import  module.
                importInfo.implicitImports.forEach(implicitImport => {
                    const symbol = this._bindNameToScope(this._currentScope, implicitImport.name);
                    if (symbol) {
                        const aliasDecl: AliasDeclaration = {
                            type: DeclarationType.Alias,
                            path: implicitImport.path,
                            range: getEmptyRange(),
                            implicitImports: new Map<string, ModuleLoaderActions>()
                        };
                        symbol.addDeclaration(aliasDecl);
                    }
                });
            }
        } else {
            node.imports.forEach(importSymbolNode => {
                const importedName = importSymbolNode.name.nameToken.value;
                const nameNode = importSymbolNode.alias || importSymbolNode.name;
                const symbol = this._bindNameToScope(this._currentScope, nameNode.nameToken.value);

                if (symbol) {
                    let aliasDecl: AliasDeclaration | undefined;

                    // Is the import referring to an implicitly-imported module?
                    let implicitImport: ImplicitImport | undefined;
                    if (importInfo && importInfo.implicitImports) {
                        implicitImport = importInfo.implicitImports.find(imp => imp.name === importedName);
                    }

                    if (implicitImport) {
                        aliasDecl = {
                            type: DeclarationType.Alias,
                            path: implicitImport.path,
                            range: getEmptyRange(),
                            implicitImports: new Map<string, ModuleLoaderActions>()
                        };
                    } else if (resolvedPath) {
                        aliasDecl = {
                            type: DeclarationType.Alias,
                            path: resolvedPath,
                            range: getEmptyRange(),
                            symbolName: importedName,
                            implicitImports: new Map<string, ModuleLoaderActions>()
                        };
                    }

                    if (aliasDecl) {
                        symbol.addDeclaration(aliasDecl);
                    }
                }
            });
        }

        return true;
    }

    visitWith(node: WithNode): boolean {
        node.withItems.forEach(item => {
            if (item.target) {
                this._bindPossibleTupleNamedTarget(item.target);
                this._addInferredTypeAssignmentForVariable(item.target, item);
            }
        });

        return true;
    }

    visitListComprehension(node: ListComprehensionNode): boolean {
        // Allocate a new scope.
        const prevScope = this._currentScope;
        this._currentScope = new Scope(ScopeType.ListComprehension, prevScope);

        node.comprehensions.forEach(compr => {
            if (compr.nodeType === ParseNodeType.ListComprehensionFor) {
                this.walk(compr.iterableExpression);

                this._bindPossibleTupleNamedTarget(compr.targetExpression);
                this.walk(compr.targetExpression);
            } else {
                this.walk(compr.testExpression);
            }
        });

        this.walk(node.expression);

        AnalyzerNodeInfo.setScope(node, this._currentScope);

        this._currentScope = prevScope;

        return false;
    }

    protected _bindNameToScope(scope: Scope, name: string) {
        if (this._notLocalBindings.get(name) === undefined) {
            // Don't overwrite an existing symbol.
            let symbol = scope.lookUpSymbol(name);
            if (!symbol) {
                symbol = scope.addSymbol(name,
                    SymbolFlags.InitiallyUnbound | SymbolFlags.ClassMember);
            }

            return symbol;
        }

        return undefined;
    }

    protected _bindPossibleTupleNamedTarget(target: ExpressionNode) {
        if (target.nodeType === ParseNodeType.Name) {
            this._bindNameToScope(this._currentScope, target.nameToken.value);
        } else if (target.nodeType === ParseNodeType.Tuple) {
            target.expressions.forEach(expr => {
                this._bindPossibleTupleNamedTarget(expr);
            });
        } else if (target.nodeType === ParseNodeType.List) {
            target.entries.forEach(expr => {
                this._bindPossibleTupleNamedTarget(expr);
            });
        } else if (target.nodeType === ParseNodeType.TypeAnnotation) {
            this._bindPossibleTupleNamedTarget(target.valueExpression);
        } else if (target.nodeType === ParseNodeType.Unpack) {
            this._bindPossibleTupleNamedTarget(target.expression);
        }
    }

    protected _addBuiltInSymbolToCurrentScope(nameValue: string, type: Type) {
        // Handle a special case where a built-in type is not known
        // at binding time. This happens specifically when binding
        // the buitins.pyi module. We'll convert the Unknown types
        // into Any and not add a real declaration so other classes
        // can override the type without getting an error.
        if (type.category === TypeCategory.Unknown) {
            this._addSymbolToCurrentScope(nameValue, AnyType.create(), defaultTypeSourceId);
        } else {
            const symbol = this._addSymbolToCurrentScope(nameValue, type, defaultTypeSourceId);
            if (symbol) {
                symbol.addDeclaration({
                    type: DeclarationType.BuiltIn,
                    declaredType: type,
                    path: this._fileInfo.filePath,
                    range: getEmptyRange()
                });
                symbol.setIsIgnoredForProtocolMatch();
            }
        }
    }

    // Finds the nearest permanent scope (as opposed to temporary scope) and
    // adds a new symbol with the specified name if it doesn't already exist.
    protected _addSymbolToCurrentScope(nameValue: string, type: Type, typeSourceId: TypeSourceId) {
        if (this._isUnexecutedCode) {
            return;
        }

        assert(this._currentScope.getType() !== ScopeType.Temporary);
        let symbol = this._currentScope.lookUpSymbol(nameValue);

        if (!symbol) {
            let symbolFlags = SymbolFlags.None;

            // If the caller specified a default type source ID, it's a
            // symbol that's populated by the module loader, so it's
            // bound at the time the module starts executing.
            if (typeSourceId !== defaultTypeSourceId) {
                symbolFlags |= SymbolFlags.InitiallyUnbound;
            }

            if (this._currentScope.getType() === ScopeType.Class) {
                symbolFlags |= SymbolFlags.ClassMember;
            }

            // Add the symbol. Assume that symbols with a default type source ID
            // are "implicit" symbols added to the scope. These are not initially unbound.
            symbol = this._currentScope.addSymbol(nameValue, symbolFlags);
        }

        symbol.setInferredTypeForSource(type, typeSourceId);
        return symbol;
    }

    protected _getDocString(statements: StatementNode[]): string | undefined {
        // See if the first statement in the suite is a triple-quote string.
        if (statements.length === 0) {
            return undefined;
        }

        if (statements[0].nodeType !== ParseNodeType.StatementList) {
            return undefined;
        }

        // If the first statement in the suite isn't a StringNode,
        // assume there is no docString.
        const statementList = statements[0];
        if (statementList.statements.length === 0 ||
                statementList.statements[0].nodeType !== ParseNodeType.StringList) {
            return undefined;
        }

        const docStringNode = statementList.statements[0];
        const docStringToken = docStringNode.strings[0].token;

        // Ignore f-strings.
        if ((docStringToken.flags & StringTokenFlags.Format) !== 0) {
            return undefined;
        }

        return DocStringUtils.decodeDocString(docStringNode.strings[0].value);
    }

    private _addInferredTypeAssignmentForVariable(target: ExpressionNode, source: ParseNode) {
        if (target.nodeType === ParseNodeType.Name) {
            const name = target.nameToken;
            const symbolWithScope = this._currentScope.lookUpSymbolRecursive(name.value);
            if (symbolWithScope && symbolWithScope.symbol) {
                const declaration: VariableDeclaration = {
                    type: DeclarationType.Variable,
                    node: target,
                    isConstant: isConstantName(target.nameToken.value),
                    inferredTypeSource: source,
                    path: this._fileInfo.filePath,
                    range: convertOffsetsToRange(name.start, TextRange.getEnd(name), this._fileInfo.lines)
                };
                symbolWithScope.symbol.addDeclaration(declaration);
            }
        } else if (target.nodeType === ParseNodeType.MemberAccess) {
            const memberAccessInfo = this._getMemberAccessInfo(target);
            if (memberAccessInfo) {
                const name = target.memberName.nameToken;

                let symbol = memberAccessInfo.classScope.lookUpSymbol(name.value);
                if (!symbol) {
                    symbol = memberAccessInfo.classScope.addSymbol(name.value,
                        SymbolFlags.InitiallyUnbound);
                }

                if (memberAccessInfo.isInstanceMember) {
                    symbol.setIsInstanceMember();
                } else {
                    symbol.setIsClassMember();
                }

                const declaration: VariableDeclaration = {
                    type: DeclarationType.Variable,
                    node: target.memberName,
                    isConstant: isConstantName(name.value),
                    inferredTypeSource: source,
                    path: this._fileInfo.filePath,
                    range: convertOffsetsToRange(target.memberName.start,
                        target.memberName.start + target.memberName.length,
                        this._fileInfo.lines)
                };
                symbol.addDeclaration(declaration);
            }
        } else if (target.nodeType === ParseNodeType.Tuple) {
            target.expressions.forEach(expr => {
                this._addInferredTypeAssignmentForVariable(expr, source);
            });
        } else if (target.nodeType === ParseNodeType.TypeAnnotation) {
            this._addInferredTypeAssignmentForVariable(target.valueExpression, source);
        } else if (target.nodeType === ParseNodeType.Unpack) {
            this._addInferredTypeAssignmentForVariable(target.expression, source);
        } else if (target.nodeType === ParseNodeType.List) {
            target.entries.forEach(entry => {
                this._addInferredTypeAssignmentForVariable(entry, source);
            });
        }
    }

    private _addTypeDeclarationForVariable(target: ExpressionNode, typeAnnotation: ExpressionNode) {
        let declarationHandled = false;

        if (target.nodeType === ParseNodeType.Name) {
            const name = target.nameToken;
            const symbolWithScope = this._currentScope.lookUpSymbolRecursive(name.value);
            if (symbolWithScope && symbolWithScope.symbol) {
                const declaration: VariableDeclaration = {
                    type: DeclarationType.Variable,
                    node: target,
                    isConstant: isConstantName(name.value),
                    path: this._fileInfo.filePath,
                    typeAnnotationNode: typeAnnotation,
                    range: convertOffsetsToRange(name.start, TextRange.getEnd(name), this._fileInfo.lines)
                };
                symbolWithScope.symbol.addDeclaration(declaration);
            }

            declarationHandled = true;
        } else if (target.nodeType === ParseNodeType.MemberAccess) {
            // We need to determine whether this expression is declaring a class or
            // instance variable. This is difficult because python doesn't provide
            // a keyword for accessing "this". Instead, it uses naming conventions
            // of "cls" and "self", but we don't want to rely on these naming
            // conventions here. Instead, we'll apply some heuristics to determine
            // whether the symbol on the LHS is a reference to the current class
            // or an instance of the current class.

            const memberAccessInfo = this._getMemberAccessInfo(target);
            if (memberAccessInfo) {
                const name = target.memberName.nameToken;

                let symbol = memberAccessInfo.classScope.lookUpSymbol(name.value);
                if (!symbol) {
                    symbol = memberAccessInfo.classScope.addSymbol(name.value,
                        SymbolFlags.InitiallyUnbound);
                }

                if (memberAccessInfo.isInstanceMember) {
                    symbol.setIsInstanceMember();
                } else {
                    symbol.setIsClassMember();
                }

                const declaration: VariableDeclaration = {
                    type: DeclarationType.Variable,
                    node: target.memberName,
                    isConstant: isConstantName(name.value),
                    path: this._fileInfo.filePath,
                    typeAnnotationNode: typeAnnotation,
                    range: convertOffsetsToRange(target.memberName.start,
                        target.memberName.start + target.memberName.length,
                        this._fileInfo.lines)
                };
                symbol.addDeclaration(declaration);

                declarationHandled = true;
            }
        }

        if (!declarationHandled) {
            this._addError(
                `Type annotation not supported for this type of expression`,
                typeAnnotation);
        }
    }

    // Determines whether a member access expression is referring to a
    // member of a class (either a class or instance member). This will
    // typically take the form "self.x" or "cls.x".
    private _getMemberAccessInfo(node: MemberAccessExpressionNode): MemberAccessInfo | undefined {
        // We handle only simple names on the left-hand side of the expression,
        // not calls, nested member accesses, index expressions, etc.
        if (node.leftExpression.nodeType !== ParseNodeType.Name) {
            return undefined;
        }

        const leftSymbolName = node.leftExpression.nameToken.value;

        // Make sure the expression is within a function (i.e. a method) that's
        // within a class definition.
        const methodNode = ParseTreeUtils.getEnclosingFunction(node);
        if (!methodNode) {
            return undefined;
        }

        const classNode = ParseTreeUtils.getEnclosingClass(methodNode);
        if (!classNode) {
            return undefined;
        }

        // Determine whether the left-hand side indicates a class or
        // instance member.
        let isInstanceMember = false;

        if (methodNode.parameters.length < 1 || !methodNode.parameters[0].name) {
            return undefined;
        }

        const className = classNode.name.nameToken.value;
        const firstParamName = methodNode.parameters[0].name.nameToken.value;

        if (leftSymbolName === className) {
            isInstanceMember = false;
        } else {
            if (leftSymbolName !== firstParamName) {
                return undefined;
            }

            // To determine whether the first parameter of the method
            // refers to the class or the instance, we need to apply
            // some heuristics.
            if (methodNode.name.nameToken.value === '__new__') {
                // The __new__ method is special. It acts as a classmethod even
                // though it doesn't have a @classmethod decorator.
                isInstanceMember = false;
            } else {
                // Assume that it's an instance member unless we find
                // a decorator that tells us otherwise.
                isInstanceMember = true;
                for (const decorator of methodNode.decorators) {
                    if (decorator.leftExpression.nodeType === ParseNodeType.Name) {
                        const decoratorName = decorator.leftExpression.nameToken.value;

                        if (decoratorName === 'staticmethod') {
                            // A static method doesn't have a "self" or "cls" parameter.
                            return undefined;
                        } else if (decoratorName === 'classmethod') {
                            // A classmethod implies that the first parameter is "cls".
                            isInstanceMember = false;
                            break;
                        }
                    }
                }
            }
        }

        const classScope = AnalyzerNodeInfo.getScope(classNode)!;
        assert(classScope !== undefined);

        return {
            classNode,
            methodNode,
            classScope,
            isInstanceMember
        };
    }

    private _addImplicitImportsToLoaderActions(importResult: ImportResult, loaderActions: ModuleLoaderActions) {
        importResult.implicitImports.forEach(implicitImport => {
            const existingLoaderAction = loaderActions.implicitImports.get(implicitImport.name);
            if (existingLoaderAction) {
                existingLoaderAction.path = implicitImport.path;
            } else {
                loaderActions.implicitImports.set(implicitImport.name, {
                    path: implicitImport.path,
                    implicitImports: new Map<string, ModuleLoaderActions>()
                });
            }
        });
    }

    // Handles some special-case assignment statements that are found
    // within the typings.pyi file.
    private _handleTypingStubAssignment(node: AssignmentNode) {
        if (!this._fileInfo.isTypingStubFile) {
            return false;
        }

        let assignedNameNode: NameNode | undefined;
        if (node.leftExpression.nodeType === ParseNodeType.Name) {
            assignedNameNode = node.leftExpression;
        } else if (node.leftExpression.nodeType === ParseNodeType.TypeAnnotation &&
            node.leftExpression.valueExpression.nodeType === ParseNodeType.Name) {
            assignedNameNode = node.leftExpression.valueExpression;
        }

        const specialTypes: { [name: string]: boolean } = {
            'overload': true,
            'TypeVar': true,
            '_promote': true,
            'no_type_check': true,
            'NoReturn': true,
            'Union': true,
            'Optional': true,
            'List': true,
            'Dict': true,
            'DefaultDict': true,
            'Set': true,
            'FrozenSet': true,
            'Deque': true,
            'ChainMap': true,
            'Tuple': true,
            'Generic': true,
            'Protocol': true,
            'Callable': true,
            'Type': true,
            'ClassVar': true,
            'Final': true,
            'Literal': true,
            'TypedDict': true
        };

        if (assignedNameNode) {
            const assignedName = assignedNameNode.nameToken.value;
            let specialType: Type | undefined;

            if (assignedName === 'Any') {
                specialType = AnyType.create();
            } else if (specialTypes[assignedName]) {
                const specialClassType = ClassType.create(assignedName,
                    ClassTypeFlags.BuiltInClass | ClassTypeFlags.SpecialBuiltIn,
                    defaultTypeSourceId);

                // We'll fill in the actual base class in the analysis phase.
                ClassType.addBaseClass(specialClassType, UnknownType.create(), false);
                specialType = specialClassType;
            }

            if (specialType) {
                AnalyzerNodeInfo.setExpressionType(assignedNameNode, specialType);
                const symbol = this._bindNameToScope(this._currentScope, assignedName);

                if (symbol) {
                    symbol.addDeclaration({
                        type: DeclarationType.BuiltIn,
                        node: assignedNameNode,
                        declaredType: specialType,
                        path: this._fileInfo.filePath,
                        range: convertOffsetsToRange(node.leftExpression.start,
                            TextRange.getEnd(node.leftExpression), this._fileInfo.lines)
                    });
                }

                return true;
            }
        }

        return false;
    }

    // Analyzes the subscopes that are discovered during the first analysis pass.
    private _analyzeSubscopesDeferred() {
        for (const subscope of this._subscopesToAnalyze) {
            subscope.bindDeferred();
        }

        this._subscopesToAnalyze = [];
    }

    private _validateYieldUsage(node: YieldExpressionNode | YieldFromExpressionNode) {
        const functionNode = ParseTreeUtils.getEnclosingFunction(node);

        if (!functionNode) {
            this._addError(
                `'yield' not allowed outside of a function`, node);
        } else if (functionNode.isAsync && node.nodeType === ParseNodeType.YieldFrom) {
            // PEP 525 indicates that 'yield from' is not allowed in an
            // async function.
            this._addError(
                `'yield from' not allowed in an async function`, node);
        }
    }

    private _handleIfWhileCommon(testExpression: ExpressionNode, ifWhileSuite: SuiteNode,
            elseSuite: SuiteNode | IfNode | undefined) {

        this.walk(testExpression);

        // Determine if the if condition is always true or always false. If so,
        // we can treat either the if or the else clause as unconditional.
        const constExprValue = StaticExpressions.evaluateStaticExpression(
            testExpression, this._fileInfo.executionEnvironment);

        // which variables have been assigned to conditionally.
        this._markNotExecuted(constExprValue === true, () => {
            this.walk(ifWhileSuite);
        });

        // Now handle the else statement if it's present. If there
        // are chained "else if" statements, they'll be handled
        // recursively here.
        if (elseSuite) {
            this._markNotExecuted(constExprValue === false, () => {
                this.walk(elseSuite);
            });
        }
    }

    private _markNotExecuted(isExecutable: boolean, callback: () => void) {
        const wasUnexecutedCode = this._isUnexecutedCode;

        if (!isExecutable) {
            this._isUnexecutedCode = true;
        }

        callback();

        this._isUnexecutedCode = wasUnexecutedCode;
    }

    private _queueSubScopeAnalyzer(binder: Binder) {
        this._subscopesToAnalyze.push(binder);
    }

    private _addDiagnostic(diagLevel: DiagnosticLevel, rule: string,
            message: string, textRange: TextRange) {

        if (diagLevel === 'error') {
            const diagnostic = this._addError(message, textRange);
            diagnostic.setRule(rule);
            return diagnostic;
        } else if (diagLevel === 'warning') {
            const diagnostic = this._addWarning(message, textRange);
            diagnostic.setRule(rule);
            return diagnostic;
        }
        return undefined;
    }

    private _addError(message: string, textRange: TextRange) {
        return this._fileInfo.diagnosticSink.addErrorWithTextRange(message, textRange);
    }

    private _addWarning(message: string, textRange: TextRange) {
        return this._fileInfo.diagnosticSink.addWarningWithTextRange(message, textRange);
    }
}

export class ModuleScopeBinder extends Binder {
    private _moduleDocString?: string;

    constructor(node: ModuleNode, fileInfo: AnalyzerFileInfo) {
        super(node, fileInfo.builtinsScope ? ScopeType.Module : ScopeType.Builtin,
            fileInfo.builtinsScope, fileInfo);

        // Bind implicit names.
        // List taken from https://docs.python.org/3/reference/import.html#__name__
        this._addBuiltInSymbolToCurrentScope('__doc__',
            ScopeUtils.getBuiltInObject(this._currentScope, 'str'));
        this._addBuiltInSymbolToCurrentScope('__name__',
            ScopeUtils.getBuiltInObject(this._currentScope, 'str'));
        this._addBuiltInSymbolToCurrentScope('__loader__', AnyType.create());
        this._addBuiltInSymbolToCurrentScope('__package__',
            ScopeUtils.getBuiltInObject(this._currentScope, 'str'));
        this._addBuiltInSymbolToCurrentScope('__spec__', AnyType.create());
        this._addBuiltInSymbolToCurrentScope('__path__', ScopeUtils.getBuiltInObject(this._currentScope, 'str'));
        this._addBuiltInSymbolToCurrentScope('__file__', ScopeUtils.getBuiltInObject(this._currentScope, 'str'));
        this._addBuiltInSymbolToCurrentScope('__cached__', ScopeUtils.getBuiltInObject(this._currentScope, 'str'));

        const moduleNode = this._scopedNode as ModuleNode;
        this.walkMultiple(moduleNode.statements);

        this._moduleDocString = this._getDocString((this._scopedNode as ModuleNode).statements);
    }

    bind() {
        this.bindDeferred();
    }

    getModuleDocString() {
        return this._moduleDocString;
    }
}

export class ClassScopeBinder extends Binder {
    constructor(node: ClassNode, parentScope: Scope, classType: ClassType,
            fileInfo: AnalyzerFileInfo) {
        super(node, ScopeType.Class, parentScope, fileInfo);

        // The scope for this class becomes the "fields" for the corresponding type.
        ClassType.setFields(classType, this._currentScope.getSymbolTable());

        assert(classType && classType.category === TypeCategory.Class);

        // Bind implicit names.
        // Note that __class__, __dict__ and __doc__ are skipped here
        // because the builtins.pyi type stub declares these in the
        // 'object' class.
        this._addBuiltInSymbolToCurrentScope('__name__',
            ScopeUtils.getBuiltInObject(this._currentScope, 'str'));
        if (this._fileInfo.executionEnvironment.pythonVersion >= PythonVersion.V33) {
            this._addBuiltInSymbolToCurrentScope('__qualname__',
                ScopeUtils.getBuiltInObject(this._currentScope, 'str'));
        }

        // Analyze the suite.
        const classNode = this._scopedNode as ClassNode;

        this.walk(classNode.suite);
    }
}

export class FunctionScopeBinder extends Binder {
    constructor(node: FunctionNode, parentScope: Scope, fileInfo: AnalyzerFileInfo) {
        super(node, ScopeType.Function, parentScope, fileInfo);

        // Bind implicit names.
        // List taken from https://docs.python.org/3/reference/datamodel.html
        this._addBuiltInSymbolToCurrentScope('__doc__',
            ScopeUtils.getBuiltInObject(this._currentScope, 'str'));
        this._addBuiltInSymbolToCurrentScope('__name__',
            ScopeUtils.getBuiltInObject(this._currentScope, 'str'));
        if (this._fileInfo.executionEnvironment.pythonVersion >= PythonVersion.V33) {
            this._addBuiltInSymbolToCurrentScope('__qualname__',
                ScopeUtils.getBuiltInObject(this._currentScope, 'str'));
        }
        this._addBuiltInSymbolToCurrentScope('__module__',
            ScopeUtils.getBuiltInObject(this._currentScope, 'str'));
        this._addBuiltInSymbolToCurrentScope('__defaults__', AnyType.create());
        this._addBuiltInSymbolToCurrentScope('__code__', AnyType.create());
        this._addBuiltInSymbolToCurrentScope('__globals__', AnyType.create());
        this._addBuiltInSymbolToCurrentScope('__dict__', AnyType.create());
        this._addBuiltInSymbolToCurrentScope('__closure__', AnyType.create());
        this._addBuiltInSymbolToCurrentScope('__annotations__', AnyType.create());
        this._addBuiltInSymbolToCurrentScope('__kwdefaults__', AnyType.create());

        const enclosingClass = ParseTreeUtils.getEnclosingClass(node);
        if (enclosingClass) {
            const enclosingClassType = AnalyzerNodeInfo.getExpressionType(enclosingClass);
            if (enclosingClassType) {
                this._addBuiltInSymbolToCurrentScope('__class__', enclosingClassType);
            }
        }
    }

    bindDeferred() {
        const functionNode = this._scopedNode as FunctionNode;

        functionNode.parameters.forEach(paramNode => {
            if (paramNode.name) {
                const symbol = this._bindNameToScope(this._currentScope, paramNode.name.nameToken.value);
                if (symbol) {
                    symbol.addDeclaration({
                        type: DeclarationType.Parameter,
                        node: paramNode,
                        path: this._fileInfo.filePath,
                        range: convertOffsetsToRange(paramNode.start, TextRange.getEnd(paramNode),
                            this._fileInfo.lines)
                    });
                }
            }
        });

        // Walk the statements that make up the function.
        this.walk(functionNode.suite);

        // Analyze any sub-scopes that were discovered during the earlier pass.
        super.bindDeferred();
    }
}

export class LambdaScopeBinder extends Binder {
    constructor(node: LambdaNode, parentScope: Scope, fileInfo: AnalyzerFileInfo) {
        super(node, ScopeType.Function, parentScope, fileInfo);
    }

    bindDeferred() {
        const lambdaNode = this._scopedNode as LambdaNode;

        lambdaNode.parameters.forEach(paramNode => {
            if (paramNode.name) {
                const symbol = this._bindNameToScope(this._currentScope, paramNode.name.nameToken.value);
                if (symbol) {
                    symbol.addDeclaration({
                        type: DeclarationType.Parameter,
                        node: paramNode,
                        path: this._fileInfo.filePath,
                        range: convertOffsetsToRange(paramNode.start, TextRange.getEnd(paramNode),
                            this._fileInfo.lines)
                    });
                }
            }
        });

        // Walk the expression that make up the lambda body.
        this.walk(lambdaNode.expression);

        // Analyze any sub-scopes that were discovered during the earlier pass.
        super.bindDeferred();
    }
}

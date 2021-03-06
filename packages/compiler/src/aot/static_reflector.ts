/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {CompileSummaryKind} from '../compile_metadata';
import {CompileReflector} from '../compile_reflector';
import {MetadataFactory, createAttribute, createComponent, createContentChild, createContentChildren, createDirective, createHost, createHostBinding, createHostListener, createInject, createInjectable, createInput, createNgModule, createOptional, createOutput, createPipe, createSelf, createSkipSelf, createViewChild, createViewChildren} from '../core';
import * as o from '../output/output_ast';
import {SummaryResolver} from '../summary_resolver';
import {syntaxError} from '../util';

import {StaticSymbol} from './static_symbol';
import {StaticSymbolResolver} from './static_symbol_resolver';

const ANGULAR_CORE = '@angular/core';
const ANGULAR_ROUTER = '@angular/router';

const HIDDEN_KEY = /^\$.*\$$/;

const IGNORE = {
  __symbolic: 'ignore'
};

const USE_VALUE = 'useValue';
const PROVIDE = 'provide';
const REFERENCE_SET = new Set([USE_VALUE, 'useFactory', 'data']);

function shouldIgnore(value: any): boolean {
  return value && value.__symbolic == 'ignore';
}

/**
 * A static reflector implements enough of the Reflector API that is necessary to compile
 * templates statically.
 */
export class StaticReflector implements CompileReflector {
  private annotationCache = new Map<StaticSymbol, any[]>();
  private propertyCache = new Map<StaticSymbol, {[key: string]: any[]}>();
  private parameterCache = new Map<StaticSymbol, any[]>();
  private methodCache = new Map<StaticSymbol, {[key: string]: boolean}>();
  private conversionMap = new Map<StaticSymbol, (context: StaticSymbol, args: any[]) => any>();
  private injectionToken: StaticSymbol;
  private opaqueToken: StaticSymbol;
  private ROUTES: StaticSymbol;
  private ANALYZE_FOR_ENTRY_COMPONENTS: StaticSymbol;
  private annotationForParentClassWithSummaryKind =
      new Map<CompileSummaryKind, MetadataFactory<any>[]>();

  constructor(
      private summaryResolver: SummaryResolver<StaticSymbol>,
      private symbolResolver: StaticSymbolResolver,
      knownMetadataClasses: {name: string, filePath: string, ctor: any}[] = [],
      knownMetadataFunctions: {name: string, filePath: string, fn: any}[] = [],
      private errorRecorder?: (error: any, fileName?: string) => void) {
    this.initializeConversionMap();
    knownMetadataClasses.forEach(
        (kc) => this._registerDecoratorOrConstructor(
            this.getStaticSymbol(kc.filePath, kc.name), kc.ctor));
    knownMetadataFunctions.forEach(
        (kf) => this._registerFunction(this.getStaticSymbol(kf.filePath, kf.name), kf.fn));
    this.annotationForParentClassWithSummaryKind.set(
        CompileSummaryKind.Directive, [createDirective, createComponent]);
    this.annotationForParentClassWithSummaryKind.set(CompileSummaryKind.Pipe, [createPipe]);
    this.annotationForParentClassWithSummaryKind.set(CompileSummaryKind.NgModule, [createNgModule]);
    this.annotationForParentClassWithSummaryKind.set(
        CompileSummaryKind.Injectable,
        [createInjectable, createPipe, createDirective, createComponent, createNgModule]);
  }

  componentModuleUrl(typeOrFunc: StaticSymbol): string {
    const staticSymbol = this.findSymbolDeclaration(typeOrFunc);
    return this.symbolResolver.getResourcePath(staticSymbol);
  }

  resolveExternalReference(ref: o.ExternalReference): StaticSymbol {
    const refSymbol = this.symbolResolver.getSymbolByModule(ref.moduleName !, ref.name !);
    const declarationSymbol = this.findSymbolDeclaration(refSymbol);
    this.symbolResolver.recordModuleNameForFileName(refSymbol.filePath, ref.moduleName !);
    this.symbolResolver.recordImportAs(declarationSymbol, refSymbol);
    return declarationSymbol;
  }

  findDeclaration(moduleUrl: string, name: string, containingFile?: string): StaticSymbol {
    return this.findSymbolDeclaration(
        this.symbolResolver.getSymbolByModule(moduleUrl, name, containingFile));
  }

  tryFindDeclaration(moduleUrl: string, name: string): StaticSymbol {
    return this.symbolResolver.ignoreErrorsFor(() => this.findDeclaration(moduleUrl, name));
  }

  findSymbolDeclaration(symbol: StaticSymbol): StaticSymbol {
    const resolvedSymbol = this.symbolResolver.resolveSymbol(symbol);
    if (resolvedSymbol && resolvedSymbol.metadata instanceof StaticSymbol) {
      return this.findSymbolDeclaration(resolvedSymbol.metadata);
    } else {
      return symbol;
    }
  }

  public annotations(type: StaticSymbol): any[] {
    let annotations = this.annotationCache.get(type);
    if (!annotations) {
      annotations = [];
      const classMetadata = this.getTypeMetadata(type);
      const parentType = this.findParentType(type, classMetadata);
      if (parentType) {
        const parentAnnotations = this.annotations(parentType);
        annotations.push(...parentAnnotations);
      }
      let ownAnnotations: any[] = [];
      if (classMetadata['decorators']) {
        ownAnnotations = this.simplify(type, classMetadata['decorators']);
        annotations.push(...ownAnnotations);
      }
      if (parentType && !this.summaryResolver.isLibraryFile(type.filePath) &&
          this.summaryResolver.isLibraryFile(parentType.filePath)) {
        const summary = this.summaryResolver.resolveSummary(parentType);
        if (summary && summary.type) {
          const requiredAnnotationTypes =
              this.annotationForParentClassWithSummaryKind.get(summary.type.summaryKind !) !;
          const typeHasRequiredAnnotation = requiredAnnotationTypes.some(
              (requiredType) => ownAnnotations.some(ann => requiredType.isTypeOf(ann)));
          if (!typeHasRequiredAnnotation) {
            this.reportError(
                syntaxError(
                    `Class ${type.name} in ${type.filePath} extends from a ${CompileSummaryKind[summary.type.summaryKind!]} in another compilation unit without duplicating the decorator. ` +
                    `Please add a ${requiredAnnotationTypes.map((type) => type.ngMetadataName).join(' or ')} decorator to the class.`),
                type);
          }
        }
      }
      this.annotationCache.set(type, annotations.filter(ann => !!ann));
    }
    return annotations;
  }

  public propMetadata(type: StaticSymbol): {[key: string]: any[]} {
    let propMetadata = this.propertyCache.get(type);
    if (!propMetadata) {
      const classMetadata = this.getTypeMetadata(type);
      propMetadata = {};
      const parentType = this.findParentType(type, classMetadata);
      if (parentType) {
        const parentPropMetadata = this.propMetadata(parentType);
        Object.keys(parentPropMetadata).forEach((parentProp) => {
          propMetadata ![parentProp] = parentPropMetadata[parentProp];
        });
      }

      const members = classMetadata['members'] || {};
      Object.keys(members).forEach((propName) => {
        const propData = members[propName];
        const prop = (<any[]>propData)
                         .find(a => a['__symbolic'] == 'property' || a['__symbolic'] == 'method');
        const decorators: any[] = [];
        if (propMetadata ![propName]) {
          decorators.push(...propMetadata ![propName]);
        }
        propMetadata ![propName] = decorators;
        if (prop && prop['decorators']) {
          decorators.push(...this.simplify(type, prop['decorators']));
        }
      });
      this.propertyCache.set(type, propMetadata);
    }
    return propMetadata;
  }

  public parameters(type: StaticSymbol): any[] {
    if (!(type instanceof StaticSymbol)) {
      this.reportError(
          new Error(`parameters received ${JSON.stringify(type)} which is not a StaticSymbol`),
          type);
      return [];
    }
    try {
      let parameters = this.parameterCache.get(type);
      if (!parameters) {
        const classMetadata = this.getTypeMetadata(type);
        const parentType = this.findParentType(type, classMetadata);
        const members = classMetadata ? classMetadata['members'] : null;
        const ctorData = members ? members['__ctor__'] : null;
        if (ctorData) {
          const ctor = (<any[]>ctorData).find(a => a['__symbolic'] == 'constructor');
          const rawParameterTypes = <any[]>ctor['parameters'] || [];
          const parameterDecorators = <any[]>this.simplify(type, ctor['parameterDecorators'] || []);
          parameters = [];
          rawParameterTypes.forEach((rawParamType, index) => {
            const nestedResult: any[] = [];
            const paramType = this.trySimplify(type, rawParamType);
            if (paramType) nestedResult.push(paramType);
            const decorators = parameterDecorators ? parameterDecorators[index] : null;
            if (decorators) {
              nestedResult.push(...decorators);
            }
            parameters !.push(nestedResult);
          });
        } else if (parentType) {
          parameters = this.parameters(parentType);
        }
        if (!parameters) {
          parameters = [];
        }
        this.parameterCache.set(type, parameters);
      }
      return parameters;
    } catch (e) {
      console.error(`Failed on type ${JSON.stringify(type)} with error ${e}`);
      throw e;
    }
  }

  private _methodNames(type: any): {[key: string]: boolean} {
    let methodNames = this.methodCache.get(type);
    if (!methodNames) {
      const classMetadata = this.getTypeMetadata(type);
      methodNames = {};
      const parentType = this.findParentType(type, classMetadata);
      if (parentType) {
        const parentMethodNames = this._methodNames(parentType);
        Object.keys(parentMethodNames).forEach((parentProp) => {
          methodNames ![parentProp] = parentMethodNames[parentProp];
        });
      }

      const members = classMetadata['members'] || {};
      Object.keys(members).forEach((propName) => {
        const propData = members[propName];
        const isMethod = (<any[]>propData).some(a => a['__symbolic'] == 'method');
        methodNames ![propName] = methodNames ![propName] || isMethod;
      });
      this.methodCache.set(type, methodNames);
    }
    return methodNames;
  }

  private findParentType(type: StaticSymbol, classMetadata: any): StaticSymbol|undefined {
    const parentType = this.trySimplify(type, classMetadata['extends']);
    if (parentType instanceof StaticSymbol) {
      return parentType;
    }
  }

  hasLifecycleHook(type: any, lcProperty: string): boolean {
    if (!(type instanceof StaticSymbol)) {
      this.reportError(
          new Error(
              `hasLifecycleHook received ${JSON.stringify(type)} which is not a StaticSymbol`),
          type);
    }
    try {
      return !!this._methodNames(type)[lcProperty];
    } catch (e) {
      console.error(`Failed on type ${JSON.stringify(type)} with error ${e}`);
      throw e;
    }
  }

  private _registerDecoratorOrConstructor(type: StaticSymbol, ctor: any): void {
    this.conversionMap.set(type, (context: StaticSymbol, args: any[]) => new ctor(...args));
  }

  private _registerFunction(type: StaticSymbol, fn: any): void {
    this.conversionMap.set(type, (context: StaticSymbol, args: any[]) => fn.apply(undefined, args));
  }

  private initializeConversionMap(): void {
    this.injectionToken = this.findDeclaration(ANGULAR_CORE, 'InjectionToken');
    this.opaqueToken = this.findDeclaration(ANGULAR_CORE, 'OpaqueToken');
    this.ROUTES = this.tryFindDeclaration(ANGULAR_ROUTER, 'ROUTES');
    this.ANALYZE_FOR_ENTRY_COMPONENTS =
        this.findDeclaration(ANGULAR_CORE, 'ANALYZE_FOR_ENTRY_COMPONENTS');

    this._registerDecoratorOrConstructor(this.findDeclaration(ANGULAR_CORE, 'Host'), createHost);
    this._registerDecoratorOrConstructor(
        this.findDeclaration(ANGULAR_CORE, 'Injectable'), createInjectable);
    this._registerDecoratorOrConstructor(this.findDeclaration(ANGULAR_CORE, 'Self'), createSelf);
    this._registerDecoratorOrConstructor(
        this.findDeclaration(ANGULAR_CORE, 'SkipSelf'), createSkipSelf);
    this._registerDecoratorOrConstructor(
        this.findDeclaration(ANGULAR_CORE, 'Inject'), createInject);
    this._registerDecoratorOrConstructor(
        this.findDeclaration(ANGULAR_CORE, 'Optional'), createOptional);
    this._registerDecoratorOrConstructor(
        this.findDeclaration(ANGULAR_CORE, 'Attribute'), createAttribute);
    this._registerDecoratorOrConstructor(
        this.findDeclaration(ANGULAR_CORE, 'ContentChild'), createContentChild);
    this._registerDecoratorOrConstructor(
        this.findDeclaration(ANGULAR_CORE, 'ContentChildren'), createContentChildren);
    this._registerDecoratorOrConstructor(
        this.findDeclaration(ANGULAR_CORE, 'ViewChild'), createViewChild);
    this._registerDecoratorOrConstructor(
        this.findDeclaration(ANGULAR_CORE, 'ViewChildren'), createViewChildren);
    this._registerDecoratorOrConstructor(this.findDeclaration(ANGULAR_CORE, 'Input'), createInput);
    this._registerDecoratorOrConstructor(
        this.findDeclaration(ANGULAR_CORE, 'Output'), createOutput);
    this._registerDecoratorOrConstructor(this.findDeclaration(ANGULAR_CORE, 'Pipe'), createPipe);
    this._registerDecoratorOrConstructor(
        this.findDeclaration(ANGULAR_CORE, 'HostBinding'), createHostBinding);
    this._registerDecoratorOrConstructor(
        this.findDeclaration(ANGULAR_CORE, 'HostListener'), createHostListener);
    this._registerDecoratorOrConstructor(
        this.findDeclaration(ANGULAR_CORE, 'Directive'), createDirective);
    this._registerDecoratorOrConstructor(
        this.findDeclaration(ANGULAR_CORE, 'Component'), createComponent);
    this._registerDecoratorOrConstructor(
        this.findDeclaration(ANGULAR_CORE, 'NgModule'), createNgModule);

    // Note: Some metadata classes can be used directly with Provider.deps.
    this._registerDecoratorOrConstructor(this.findDeclaration(ANGULAR_CORE, 'Host'), createHost);
    this._registerDecoratorOrConstructor(this.findDeclaration(ANGULAR_CORE, 'Self'), createSelf);
    this._registerDecoratorOrConstructor(
        this.findDeclaration(ANGULAR_CORE, 'SkipSelf'), createSkipSelf);
    this._registerDecoratorOrConstructor(
        this.findDeclaration(ANGULAR_CORE, 'Optional'), createOptional);
  }

  /**
   * getStaticSymbol produces a Type whose metadata is known but whose implementation is not loaded.
   * All types passed to the StaticResolver should be pseudo-types returned by this method.
   *
   * @param declarationFile the absolute path of the file where the symbol is declared
   * @param name the name of the type.
   */
  getStaticSymbol(declarationFile: string, name: string, members?: string[]): StaticSymbol {
    return this.symbolResolver.getStaticSymbol(declarationFile, name, members);
  }

  private reportError(error: Error, context: StaticSymbol, path?: string) {
    if (this.errorRecorder) {
      this.errorRecorder(error, (context && context.filePath) || path);
    } else {
      throw error;
    }
  }

  /**
   * Simplify but discard any errors
   */
  private trySimplify(context: StaticSymbol, value: any): any {
    const originalRecorder = this.errorRecorder;
    this.errorRecorder = (error: any, fileName: string) => {};
    const result = this.simplify(context, value);
    this.errorRecorder = originalRecorder;
    return result;
  }

  /** @internal */
  public simplify(context: StaticSymbol, value: any): any {
    const self = this;
    let scope = BindingScope.empty;
    const calling = new Map<StaticSymbol, boolean>();

    function simplifyInContext(
        context: StaticSymbol, value: any, depth: number, references: number): any {
      function resolveReferenceValue(staticSymbol: StaticSymbol): any {
        const resolvedSymbol = self.symbolResolver.resolveSymbol(staticSymbol);
        return resolvedSymbol ? resolvedSymbol.metadata : null;
      }

      function simplifyCall(functionSymbol: StaticSymbol, targetFunction: any, args: any[]) {
        if (targetFunction && targetFunction['__symbolic'] == 'function') {
          if (calling.get(functionSymbol)) {
            throw new Error('Recursion not supported');
          }
          try {
            const value = targetFunction['value'];
            if (value && (depth != 0 || value.__symbolic != 'error')) {
              const parameters: string[] = targetFunction['parameters'];
              const defaults: any[] = targetFunction.defaults;
              args = args.map(arg => simplifyInContext(context, arg, depth + 1, references))
                         .map(arg => shouldIgnore(arg) ? undefined : arg);
              if (defaults && defaults.length > args.length) {
                args.push(...defaults.slice(args.length).map((value: any) => simplify(value)));
              }
              calling.set(functionSymbol, true);
              const functionScope = BindingScope.build();
              for (let i = 0; i < parameters.length; i++) {
                functionScope.define(parameters[i], args[i]);
              }
              const oldScope = scope;
              let result: any;
              try {
                scope = functionScope.done();
                result = simplifyInContext(functionSymbol, value, depth + 1, references);
              } finally {
                scope = oldScope;
              }
              return result;
            }
          } finally {
            calling.delete(functionSymbol);
          }
        }

        if (depth === 0) {
          // If depth is 0 we are evaluating the top level expression that is describing element
          // decorator. In this case, it is a decorator we don't understand, such as a custom
          // non-angular decorator, and we should just ignore it.
          return IGNORE;
        }
        return simplify(
            {__symbolic: 'error', message: 'Function call not supported', context: functionSymbol});
      }

      function simplify(expression: any): any {
        if (isPrimitive(expression)) {
          return expression;
        }
        if (expression instanceof Array) {
          const result: any[] = [];
          for (const item of (<any>expression)) {
            // Check for a spread expression
            if (item && item.__symbolic === 'spread') {
              // We call with references as 0 because we require the actual value and cannot
              // tolerate a reference here.
              const spreadArray = simplifyInContext(context, item.expression, depth, 0);
              if (Array.isArray(spreadArray)) {
                for (const spreadItem of spreadArray) {
                  result.push(spreadItem);
                }
                continue;
              }
            }
            const value = simplify(item);
            if (shouldIgnore(value)) {
              continue;
            }
            result.push(value);
          }
          return result;
        }
        if (expression instanceof StaticSymbol) {
          // Stop simplification at builtin symbols or if we are in a reference context and
          // the symbol doesn't have members.
          if (expression === self.injectionToken || self.conversionMap.has(expression) ||
              (references > 0 && !expression.members.length)) {
            return expression;
          } else {
            const staticSymbol = expression;
            const declarationValue = resolveReferenceValue(staticSymbol);
            if (declarationValue != null) {
              return simplifyInContext(staticSymbol, declarationValue, depth + 1, references);
            } else {
              return staticSymbol;
            }
          }
        }
        if (expression) {
          if (expression['__symbolic']) {
            let staticSymbol: StaticSymbol;
            switch (expression['__symbolic']) {
              case 'binop':
                let left = simplify(expression['left']);
                if (shouldIgnore(left)) return left;
                let right = simplify(expression['right']);
                if (shouldIgnore(right)) return right;
                switch (expression['operator']) {
                  case '&&':
                    return left && right;
                  case '||':
                    return left || right;
                  case '|':
                    return left | right;
                  case '^':
                    return left ^ right;
                  case '&':
                    return left & right;
                  case '==':
                    return left == right;
                  case '!=':
                    return left != right;
                  case '===':
                    return left === right;
                  case '!==':
                    return left !== right;
                  case '<':
                    return left < right;
                  case '>':
                    return left > right;
                  case '<=':
                    return left <= right;
                  case '>=':
                    return left >= right;
                  case '<<':
                    return left << right;
                  case '>>':
                    return left >> right;
                  case '+':
                    return left + right;
                  case '-':
                    return left - right;
                  case '*':
                    return left * right;
                  case '/':
                    return left / right;
                  case '%':
                    return left % right;
                }
                return null;
              case 'if':
                let condition = simplify(expression['condition']);
                return condition ? simplify(expression['thenExpression']) :
                                   simplify(expression['elseExpression']);
              case 'pre':
                let operand = simplify(expression['operand']);
                if (shouldIgnore(operand)) return operand;
                switch (expression['operator']) {
                  case '+':
                    return operand;
                  case '-':
                    return -operand;
                  case '!':
                    return !operand;
                  case '~':
                    return ~operand;
                }
                return null;
              case 'index':
                let indexTarget = simplifyInContext(context, expression['expression'], depth, 0);
                let index = simplifyInContext(context, expression['index'], depth, 0);
                if (indexTarget && isPrimitive(index)) return indexTarget[index];
                return null;
              case 'select':
                const member = expression['member'];
                let selectContext = context;
                let selectTarget = simplify(expression['expression']);
                if (selectTarget instanceof StaticSymbol) {
                  const members = selectTarget.members.concat(member);
                  selectContext =
                      self.getStaticSymbol(selectTarget.filePath, selectTarget.name, members);
                  const declarationValue = resolveReferenceValue(selectContext);
                  if (declarationValue != null) {
                    return simplifyInContext(
                        selectContext, declarationValue, depth + 1, references);
                  } else {
                    return selectContext;
                  }
                }
                if (selectTarget && isPrimitive(member))
                  return simplifyInContext(
                      selectContext, selectTarget[member], depth + 1, references);
                return null;
              case 'reference':
                // Note: This only has to deal with variable references,
                // as symbol references have been converted into StaticSymbols already
                // in the StaticSymbolResolver!
                const name: string = expression['name'];
                const localValue = scope.resolve(name);
                if (localValue != BindingScope.missing) {
                  return localValue;
                }
                break;
              case 'class':
                return context;
              case 'function':
                return context;
              case 'new':
              case 'call':
                // Determine if the function is a built-in conversion
                staticSymbol = simplifyInContext(
                    context, expression['expression'], depth + 1, /* references */ 0);
                if (staticSymbol instanceof StaticSymbol) {
                  if (staticSymbol === self.injectionToken || staticSymbol === self.opaqueToken) {
                    // if somebody calls new InjectionToken, don't create an InjectionToken,
                    // but rather return the symbol to which the InjectionToken is assigned to.

                    // OpaqueToken is supported too as it is required by the language service to
                    // support v4 and prior versions of Angular.
                    return context;
                  }
                  const argExpressions: any[] = expression['arguments'] || [];
                  let converter = self.conversionMap.get(staticSymbol);
                  if (converter) {
                    const args =
                        argExpressions
                            .map(arg => simplifyInContext(context, arg, depth + 1, references))
                            .map(arg => shouldIgnore(arg) ? undefined : arg);
                    return converter(context, args);
                  } else {
                    // Determine if the function is one we can simplify.
                    const targetFunction = resolveReferenceValue(staticSymbol);
                    return simplifyCall(staticSymbol, targetFunction, argExpressions);
                  }
                }
                return IGNORE;
              case 'error':
                let message = produceErrorMessage(expression);
                if (expression['line']) {
                  message =
                      `${message} (position ${expression['line']+1}:${expression['character']+1} in the original .ts file)`;
                  self.reportError(
                      positionalError(
                          message, context.filePath, expression['line'], expression['character']),
                      context);
                } else {
                  self.reportError(new Error(message), context);
                }
                return IGNORE;
              case 'ignore':
                return expression;
            }
            return null;
          }
          return mapStringMap(expression, (value, name) => {
            if (REFERENCE_SET.has(name)) {
              if (name === USE_VALUE && PROVIDE in expression) {
                // If this is a provider expression, check for special tokens that need the value
                // during analysis.
                const provide = simplify(expression.provide);
                if (provide === self.ROUTES || provide == self.ANALYZE_FOR_ENTRY_COMPONENTS) {
                  return simplify(value);
                }
              }
              return simplifyInContext(context, value, depth, references + 1);
            }
            return simplify(value);
          });
        }
        return IGNORE;
      }

      try {
        return simplify(value);
      } catch (e) {
        const members = context.members.length ? `.${context.members.join('.')}` : '';
        const message =
            `${e.message}, resolving symbol ${context.name}${members} in ${context.filePath}`;
        if (e.fileName) {
          throw positionalError(message, e.fileName, e.line, e.column);
        }
        throw syntaxError(message);
      }
    }

    const recordedSimplifyInContext = (context: StaticSymbol, value: any) => {
      try {
        return simplifyInContext(context, value, 0, 0);
      } catch (e) {
        this.reportError(e, context);
      }
    };

    const result = this.errorRecorder ? recordedSimplifyInContext(context, value) :
                                        simplifyInContext(context, value, 0, 0);
    if (shouldIgnore(result)) {
      return undefined;
    }
    return result;
  }

  private getTypeMetadata(type: StaticSymbol): {[key: string]: any} {
    const resolvedSymbol = this.symbolResolver.resolveSymbol(type);
    return resolvedSymbol && resolvedSymbol.metadata ? resolvedSymbol.metadata :
                                                       {__symbolic: 'class'};
  }
}

function expandedMessage(error: any): string {
  switch (error.message) {
    case 'Reference to non-exported class':
      if (error.context && error.context.className) {
        return `Reference to a non-exported class ${error.context.className}. Consider exporting the class`;
      }
      break;
    case 'Variable not initialized':
      return 'Only initialized variables and constants can be referenced because the value of this variable is needed by the template compiler';
    case 'Destructuring not supported':
      return 'Referencing an exported destructured variable or constant is not supported by the template compiler. Consider simplifying this to avoid destructuring';
    case 'Could not resolve type':
      if (error.context && error.context.typeName) {
        return `Could not resolve type ${error.context.typeName}`;
      }
      break;
    case 'Function call not supported':
      let prefix =
          error.context && error.context.name ? `Calling function '${error.context.name}', f` : 'F';
      return prefix +
          'unction calls are not supported. Consider replacing the function or lambda with a reference to an exported function';
    case 'Reference to a local symbol':
      if (error.context && error.context.name) {
        return `Reference to a local (non-exported) symbol '${error.context.name}'. Consider exporting the symbol`;
      }
      break;
  }
  return error.message;
}

function produceErrorMessage(error: any): string {
  return `Error encountered resolving symbol values statically. ${expandedMessage(error)}`;
}

function mapStringMap(input: {[key: string]: any}, transform: (value: any, key: string) => any):
    {[key: string]: any} {
  if (!input) return {};
  const result: {[key: string]: any} = {};
  Object.keys(input).forEach((key) => {
    const value = transform(input[key], key);
    if (!shouldIgnore(value)) {
      if (HIDDEN_KEY.test(key)) {
        Object.defineProperty(result, key, {enumerable: false, configurable: true, value: value});
      } else {
        result[key] = value;
      }
    }
  });
  return result;
}

function isPrimitive(o: any): boolean {
  return o === null || (typeof o !== 'function' && typeof o !== 'object');
}

interface BindingScopeBuilder {
  define(name: string, value: any): BindingScopeBuilder;
  done(): BindingScope;
}

abstract class BindingScope {
  abstract resolve(name: string): any;
  public static missing = {};
  public static empty: BindingScope = {resolve: name => BindingScope.missing};

  public static build(): BindingScopeBuilder {
    const current = new Map<string, any>();
    return {
      define: function(name, value) {
        current.set(name, value);
        return this;
      },
      done: function() {
        return current.size > 0 ? new PopulatedScope(current) : BindingScope.empty;
      }
    };
  }
}

class PopulatedScope extends BindingScope {
  constructor(private bindings: Map<string, any>) { super(); }

  resolve(name: string): any {
    return this.bindings.has(name) ? this.bindings.get(name) : BindingScope.missing;
  }
}

function positionalError(message: string, fileName: string, line: number, column: number): Error {
  const result = new Error(message);
  (result as any).fileName = fileName;
  (result as any).line = line;
  (result as any).column = column;
  return result;
}
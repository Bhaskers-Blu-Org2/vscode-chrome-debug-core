/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as _ from 'lodash';
import { printTopLevelObjectDescription } from './printObjectDescription';
import { logger } from 'vscode-debugadapter';
import { shouldLog } from './decorators';

enum Synchronicity {
    Sync,
    Async
}

enum Outcome {
    Succesful,
    Failure
}

export class ReplacementInstruction {
    public constructor(
        public readonly pattern: RegExp,
        public readonly replacement: string) { }
}

export interface IMethodsCalledLoggerConfiguration {
    readonly replacements: ReplacementInstruction[];

    customizeResult(methodName: string | symbol | number, args: unknown[], result: unknown): unknown;
    customizeArgumentsBeforeCall(receiverName: string, methodName: string | symbol | number, args: unknown[]): void;
}

export class MethodsCalledLoggerConfiguration implements IMethodsCalledLoggerConfiguration {

    public constructor(public readonly containerName: string, private _replacements: ReplacementInstruction[]) { }

    public customizeResult(_methodName: string | symbol | number, _args: unknown[], result: unknown): unknown {
        return result;
    }

    public customizeArgumentsBeforeCall(receiverName: string, methodName: string | symbol | number, args: object[]): void {
        if (methodName === 'on' && args.length >= 2) {
            args[1] = new MethodsCalledLogger(this, args[1], `(${receiverName} emits ${args[0]})`).wrapped();
        }
    }

    public get replacements(): ReplacementInstruction[] {
        return this._replacements;
    }

    public updateReplacements(replacements: ReplacementInstruction[]): void {
        this._replacements = replacements;
    }
}

export class MethodsCalledLogger<T extends object> {
    private static _nextCallId = 10000;
    constructor(
        private readonly _configuration: IMethodsCalledLoggerConfiguration,
        private readonly _objectToWrap: T,
        private readonly _objectToWrapName: string) {
    }

    public wrapped(): T {
        const handler = {
            get: <K extends keyof T>(target: T, propertyKey: K, receiver: any) => {
                const originalPropertyValue = target[propertyKey];
                if (!shouldLog(originalPropertyValue, propertyKey)) {
                    return originalPropertyValue;
                }

                // tslint:disable-next-line: strict-type-predicates
                if (typeof originalPropertyValue === 'function') {
                    return (...args: any) => {
                        const callId = this.generateCallId();
                        try {
                            this.logCallStart(propertyKey, args, callId);
                            this._configuration.customizeArgumentsBeforeCall(this._objectToWrapName, propertyKey, args);
                            const result = originalPropertyValue.apply(target, args);
                            if (!result || !result.then) {
                                this.logCall(propertyKey, Synchronicity.Sync, args, Outcome.Succesful, result, callId);
                                if (result === target) {
                                    return receiver;
                                } else {
                                    return this._configuration.customizeResult(propertyKey, args, result);
                                }
                            } else {
                                this.logSyncPartFinished(propertyKey, args, callId);
                                return result.then((promiseResult: unknown) => {
                                    this.logCall(propertyKey, Synchronicity.Async, args, Outcome.Succesful, promiseResult, callId);
                                    if (promiseResult === target) {
                                        return receiver;
                                    } else {
                                        return this._configuration.customizeResult(propertyKey, args, promiseResult);
                                    }
                                }, (error: unknown) => {
                                    this.logCall(propertyKey, Synchronicity.Async, args, Outcome.Failure, error, callId);
                                    return Promise.reject(error);
                                });
                            }
                        } catch (exception) {
                            this.logCall(propertyKey, Synchronicity.Sync, args, Outcome.Failure, exception, callId);
                            throw exception;
                        }
                    };
                } else {
                    return originalPropertyValue;
                }
            }
        };

        return new Proxy<T>(this._objectToWrap, handler);
    }

    private generateCallId(): number {
        return MethodsCalledLogger._nextCallId++;
    }

    private printMethodName(propertyKey: PropertyKey): string {
        return `${this._objectToWrapName}.${String(propertyKey)}`;
    }

    private printMethodCall(propertyKey: PropertyKey, methodCallArguments: any[]): string {
        return `${this.printMethodName(propertyKey)}(${this.printArguments(methodCallArguments)})`;
    }

    private printMethodResponse(outcome: Outcome, resultOrException: unknown): string {
        return `${outcome === Outcome.Succesful ? '->' : 'threw'} ${this.printObject(resultOrException)}`;
    }

    private printMethodSynchronicity(synchronicity: Synchronicity): string {
        return `${synchronicity === Synchronicity.Sync ? '' : ' async'}`;
    }

    private logCallStart(propertyKey: PropertyKey, methodCallArguments: any[], callId: number): void {
        const message = `START ${callId}: ${this.printMethodCall(propertyKey, methodCallArguments)}`;
        logger.verbose(message);
    }

    private logSyncPartFinished(propertyKey: PropertyKey, _methodCallArguments: any[], callId: number): void {
        const message = `SNRET ${callId}: ${this.printMethodName(propertyKey)}`;
        logger.verbose(message);
    }

    private logCall(propertyKey: PropertyKey, synchronicity: Synchronicity, methodCallArguments: any[], outcome: Outcome, resultOrException: unknown, callId: number): void {
        const endPrefix = callId ? `END   ${callId}: ` : '';
        const message = `${endPrefix}${this.printMethodCall(propertyKey, methodCallArguments)} ${this.printMethodSynchronicity(synchronicity)}  ${this.printMethodResponse(outcome, resultOrException)}`;
        logger.verbose(message);
    }

    private printArguments(methodCallArguments: any[]): string {
        return methodCallArguments.map(methodCallArgument => this.printObject(methodCallArgument)).join(', ');
    }

    private printObject(objectToPrint: unknown): string {
        const description = printTopLevelObjectDescription(objectToPrint);
        const printedReduced = _.reduce(Array.from(this._configuration.replacements),
            (text, replacement) =>
                text.replace(replacement.pattern, replacement.replacement),
            description);

        return printedReduced;
    }
}

export function wrapWithMethodLogger<T extends object>(objectToWrap: T, objectToWrapName = `${objectToWrap}`): T {
    return new MethodsCalledLogger(new MethodsCalledLoggerConfiguration('no container', []), objectToWrap, objectToWrapName).wrapped();
}
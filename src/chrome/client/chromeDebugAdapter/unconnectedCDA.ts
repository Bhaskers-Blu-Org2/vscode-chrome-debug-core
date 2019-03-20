/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as errors from '../../../errors';
import * as utils from '../../../utils';
import { Logger } from 'vscode-debugadapter';
import { IClientCapabilities, IDebugAdapterState, ILaunchRequestArgs, ITelemetryPropertyCollector, IAttachRequestArgs } from '../../../debugAdapterInterfaces';
import { TYPES } from '../../dependencyInjection.ts/types';
import { Logging, ILoggingConfiguration } from '../../internal/services/logging';
import { ConnectedCDAConfiguration } from './cdaConfiguration';
import { IChromeDebugAdapterOpts } from '../../chromeDebugSession';
import { CommandText } from '../requests';
import { injectable, inject } from 'inversify';
import { ConnectingCDAProvider } from './connectingCDA';
import { ISession } from '../session';

export enum ScenarioType {
    Launch,
    Attach
}

// TODO: This file needs a lot of work. We need to improve/simplify all this code when possible

export type UnconnectedCDAProvider = (clientCapabilities: IClientCapabilities) => UnconnectedCDA;
export type ILoggerSetter = (logger: Logging) => void;

@injectable()
export class UnconnectedCDA implements IDebugAdapterState {
    constructor(
        @inject(TYPES.IChromeDebugSessionOpts) private readonly _debugSessionOptions: IChromeDebugAdapterOpts,
        @inject(TYPES.ISession) private readonly _session: ISession,
        @inject(TYPES.ILoggerSetter) private readonly _loggerSetter: ILoggerSetter,
        @inject(TYPES.ConnectingCDAProvider) private readonly _connectingCDAProvider: ConnectingCDAProvider,
        @inject(TYPES.IClientCapabilities) private readonly _clientCapabilities: IClientCapabilities) { }

    public processRequest(requestName: CommandText, args: unknown, telemetryPropertyCollector?: ITelemetryPropertyCollector): Promise<unknown> {
        switch (requestName) {
            case 'launch':
                return this.launch(<ILaunchRequestArgs>args, telemetryPropertyCollector);
            case 'attach':
                return this.attach(<IAttachRequestArgs>args, telemetryPropertyCollector);
            default:
                throw new Error(`The unconnected debug adapter is not prepared to respond to the request ${requestName}`);
        }
    }

    public async launch(args: ILaunchRequestArgs, telemetryPropertyCollector?: ITelemetryPropertyCollector): Promise<IDebugAdapterState> {
        return this.createConnection(ScenarioType.Launch, args, telemetryPropertyCollector);
    }

    public async attach(args: IAttachRequestArgs, telemetryPropertyCollector?: ITelemetryPropertyCollector): Promise<IDebugAdapterState> {
        const updatedArgs = Object.assign({}, { port: 9229 }, args);
        return this.createConnection(ScenarioType.Attach, updatedArgs, telemetryPropertyCollector);
    }

    private parseLoggingConfiguration(args: ILaunchRequestArgs | IAttachRequestArgs): ILoggingConfiguration {
        const traceMapping: { [key: string]: Logger.LogLevel | undefined } = { true: Logger.LogLevel.Warn, verbose: Logger.LogLevel.Verbose };
        const traceValue = args.trace && traceMapping[args.trace.toString().toLowerCase()];
        return { logLevel: traceValue, logFilePath: args.logFilePath, shouldLogTimestamps: args.logTimestamps };
    }

    private async createConnection(scenarioType: ScenarioType, args: ILaunchRequestArgs | IAttachRequestArgs, telemetryPropertyCollector?: ITelemetryPropertyCollector): Promise<IDebugAdapterState> {
        if (this._clientCapabilities.pathFormat !== 'path') {
            throw errors.pathFormat();
        }

        utils.setCaseSensitivePaths(this._clientCapabilities.clientID !== 'visualstudio'); // TODO: Find a way to remove this

        const logging = new Logging().install(this._debugSessionOptions.extensibilityPoints, this.parseLoggingConfiguration(args));
        this._loggerSetter(logging);

        return await (await this._connectingCDAProvider(this.createConfiguration(args, scenarioType)).install()).connect(telemetryPropertyCollector);
    }

    private createConfiguration(args: ILaunchRequestArgs | IAttachRequestArgs, scenarioType: ScenarioType): ConnectedCDAConfiguration {
        return new ConnectedCDAConfiguration(this._debugSessionOptions.extensibilityPoints, this.parseLoggingConfiguration(args), this._session, this._clientCapabilities, scenarioType, args);
    }
}
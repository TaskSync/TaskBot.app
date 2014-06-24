/// <reference path="asyncmachine-task.d.ts" />
/// <reference path="../node_modules/asyncmachine/lib/asyncmachine.d.ts" />
/// <reference path="../d.ts/async.d.ts" />
/// <reference path="../d.ts/imap.d.ts" />
/// <reference path="../d.ts/global.d.ts" />
import asyncmachine = require('asyncmachine');
export declare class Message {
    public subject: string;
    public body: string;
    public labels: string[];
    public id: number;
    public query: any;
    public fetch_id: number;
    constructor(id: number, subject: string, labels: string[], body?: string);
}
export declare class Query extends asyncmachine.AsyncMachine {
    public Fetching: {
        blocks: string[];
    };
    public Idle: {
        blocks: string[];
    };
    public FetchingQuery: {
        implies: string[];
        blocks: string[];
    };
    public QueryFetched: {
        implies: string[];
        block: string[];
    };
    public FetchingResults: {
        implies: string[];
        requires: string[];
    };
    public ResultsFetched: {
        blocks: string[];
    };
    public FetchingMessage: {
        implies: string[];
        blocks: string[];
        requires: string[];
    };
    public MessageFetched: {
        implies: string[];
        blocks: string[];
        requires: string[];
    };
    public ResultsFetchingError: {
        implies: string[];
        blocks: string[];
    };
    public QueryFetchingError: {
        implies: string[];
        blocks: string[];
    };
    public active: boolean;
    public last_update: number;
    public next_update: number;
    public headers: {
        bodies: string;
        struct: boolean;
    };
    public connection: any;
    public query: string;
    public update_interval: number;
    public fetch: any;
    public msg: any;
    public query_results: IHash<Message>;
    public messages: IHash<Message>;
    constructor(connection: any, query: any, update_interval: any);
    public FetchingQuery_enter(): boolean;
    public QueryFetched_enter(states: any, results: any): any;
    public FetchingResults_enter(states: any, results: any): any;
    public FetchingMessage_enter(states: any, msg: any): any;
    public FetchingMessage_exit(): any;
    public FetchingMessage_MessageFetched(states: any, imap_msg: any, attrs: any, body: any): boolean;
    public FetchingResults_exit(): any;
    public ResultsFetchingError_enter(err: any): void;
}
export declare class Connection extends asyncmachine.AsyncMachine {
    public queries: Query[];
    public queries_executing: Query[];
    public queries_executing_limit: number;
    public imap: imap.Imap;
    public query_timer: any;
    public settings: IGtdBotSettings;
    public box: any;
    public fetch: any;
    public Connecting: {
        requires: string[];
        blocks: string[];
    };
    public Connected: {
        requires: string[];
        blocks: string[];
        implies: string[];
    };
    public Ready: {
        requires: string[];
    };
    public Idle: {
        requires: string[];
        block: string[];
    };
    public Active: {};
    public ExecutingQueries: {
        blocks: string[];
    };
    public QueryFetched: {
        requires: string[];
    };
    public Disconnecting: {
        blocks: string[];
    };
    public DisconnectingQueries: {
        requires: string[];
    };
    public Disconnected: {
        blocks: string[];
    };
    public Fetching: {
        blocks: string[];
        requires: string[];
    };
    public OpeningBox: {
        requires: string[];
        blocks: string[];
    };
    public BoxOpened: {
        requires: string[];
        depends: string[];
        blocks: string[];
    };
    public BoxClosing: {
        blocks: string[];
    };
    public BoxClosed: {
        blocks: string[];
    };
    public BoxOpeningError: {
        drops: string[];
    };
    constructor(settings: any);
    public addQuery(query: any, update_interval: any): any;
    public Connecting_enter(states: any): void;
    public Connecting_exit(states: any): any;
    public Connected_enter(): boolean;
    public Connected_exit(): any;
    public OpeningBox_enter(): boolean;
    public BoxOpened_enter(states: any, err: any, box: any): any;
    public BoxOpeningError_enter(err: any): void;
    public BoxClosing_enter(): any;
    public Ready_enter(): boolean;
    public Active_enter(): boolean;
    public Connected_Active(): boolean;
    public ExecutingQueries_enter(): any;
    public ExecutingQueries_Disconnecting(states: any, force: any): void;
    public Fetching_exit(): boolean;
    public Disconnected_enter(states: any, force: any): boolean;
    public Disconnecting_exit(): boolean;
    public fetchScheduledQueries(): any;
    public minInterval_(): any;
}

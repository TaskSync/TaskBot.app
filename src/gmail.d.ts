///<reference path="../d.ts/global.d.ts"/>
///<reference path="../d.ts/imap.d.ts"/>
///<reference path="../node_modules/asyncmachine/build/asyncmachine.d.ts"/>
///<reference path="asyncmachine-task.d.ts"/>
	
class Connection extends asyncmachine.AsyncMachine {

	// ATTRIBUTES
	
	connection: imap.Imap;
	settings: IGtdBotSettings;

	queries: Query[];
	queries_running: Query[];
	queries_running_limit: number;
	
	last_promise: rsvp.Defered;
	box_opening_promise: rsvp.Defered;
	delayed_timer: number;
}

class Query extends Task {
}
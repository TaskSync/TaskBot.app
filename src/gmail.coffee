#<reference path="externs.d.ts"/>
#<reference path="node.d.ts"/>
# #<reference path="../../node_modules/multistatemachine/build/lib/multistatemachine.d.ts"/>

settings = require '../../settings'
imap = require "imap"
ImapConnection = imap.ImapConnection
repl = require 'repl'
#import sugar = module('sugar')
require 'sugar'
asyncmachine = require 'asyncmachine'
am_task = require 'asyncmachine-task'
rsvp = require 'rsvp'

# TODO config
Object.merge settings, gmail_max_results: 300

class SearchAgent extends am_task.Task
	#	private msg: imap.ImapMessage;

	# Tells that the instance has some monitored messages.
	Fetched: {}

	# Aggregating state
	Fetching:
		blocks: [ 'Idle' ]

	Idle:
		blocks: [ 'Fetching' ]

	FetchingQuery:
		implies: [ 'Fetching' ],
		blocks: [ 'FetchingResults' ]

	FetchingResults:
		implies: [ 'Fetching' ],
		blocks: [ 'FetchingQuery' ]

	ResultsFetchingError:
		implies: [ 'Idle' ]

	FetchingMessage:
		blocks: [ 'MessageFetched' ],
		requires: [ 'FetchingResults' ]

	MessageFetched:
		blocks: [ 'FetchingMessage' ],
		requires: [ 'FetchingResults' ]

	# Attributes

	active: true
	last_update: 0
	headers: [ "id", "from", "to", "subject", "date" ]
	monitored: []		
	manager: null
	name: "*"
	update_interval: 10*1000

	constructor: (manager, name, update_interval) ->
		super()
				
		@register 'Fetched', 'Fetching', 'Idle', 'FetchingQuery', 'FetchingResults',
			'ResultsFetchingError', 'FetchingMessage', 'MessageFetched'
				
		@debug '[search] '
		@set 'Idle'

		@manager = manager if manager
		@name = name if name
		@update_interval = update_interval if update_interval

#	Idle_FetchingQuery: ->
	FetchingQuery_enter: ->
		@last_update = Date.now()
		@log  "performing a search for " + @name 
		imap = @manager.connection
		imap.search [ [ 'X-GM-RAW', @name ] ], (err, results) =>
			@add 'FetchingResults', err, results

	FetchingQuery_FetchingResults: (states, err, results) ->
		# TODO handle err
		@log 'got search results'
		imap = @manager.connection
		fetch = imap.fetch results, @headers
		# Subscribe state changes to fetching events.
		fetch.on "error", @addLater 'ResultsFetchingError'
		fetch.on "end", =>
			@add 'HasMonitored'
			@drop 'FetchingResults'
		# TODO fix when params will work
		fetch.on "message", (msg: imap.ImapMessage) =>
			 @add 'FetchingMessage', msg

#	FetchingMessage_enter( states, params, msg ) {
	FetchingMessage_enter: (states, msg) ->
		msg.on 'end', =>
			@add 'MessageFetched', msg

#	FetchingMessage_MessageFetched( states, params ) {
	FetchingMessage_MessageFetched: (states, msg) ->
		id = msg['x-gm-msgid']
		if not ~@monitored.indexOf id
			# # TODO event
			labels = msg['x-gm-labels'].join ', '
			@log 'New msg "' + msg.headers.subject + '" (' + labels + ')'
			@monitored.push id

	ResultsFetchingError_enter: (err) ->
		@log 'fetching error', err
		setTimeout @addLater('Idle'), 0
		if err
			throw new Error err

	# TODO FIXME
	repl: ->
		repl = repl.start(
			prompt: "repl> "
			input: process.stdin
			output: process.stdout
		)
		repl.context.this = @
	log: (...msgs) ->
		@log.apply console, msgs

# TODO IDLE state
class GmailManager extends asyncmachine.AsyncMachine

	# ATTRIBUTES

	max_concurrency: 3
	searches: []
	connection: imap.ImapConnection
	box_opening_promise: null
	delayed_timer: number
	concurrency: []
	threads: []
	settings: {}
		
	# STATES
		
	Disconnected:
		blocks: ['Connected', 'Connecting', 'Disconnecting']

	Disconnecting:
		blocks: ['Connected', 'Connecting', 'Disconnected']

	Connected:
		blocks: [ 'Connecting', 'Disconnecting', 'Disconnected' ]
		implies: [ 'BoxClosed' ]

	Connecting:
		blocks: ['Connected', 'Disconnecting', 'Disconnected']

	Idle:
		requires: [ 'Connected' ]

	Active:
		requires: [ 'Connected' ]

	Fetched: {}

	Fetching:
		requires: [ 'BoxOpened' ]
		blocks: [ 'Idle', 'Delayed' ]

	Delayed:
		requires: [ 'Active' ] 
		blocks: [ 'Fetching', 'Idle' ]

	BoxOpening:
		requires: [ 'Active' ]
		blocks: [ 'BoxOpened', 'BoxClosing', 'BoxClosed' ]
		group: 'OpenBox'

	BoxOpened:
		depends: [ 'Connected' ]
		requires: [ 'Active' ]
		blocks: [ 'BoxOpening', 'BoxClosed', 'BoxClosing' ]
		group: 'OpenBox'

	BoxClosing:
		blocks: [ 'BoxOpened', 'BoxOpening', 'Box' ]
		group: 'OpenBox'

	BoxClosed:
		requires: [ 'Active' ]
		blocks: [ 'BoxOpened', 'BoxOpening', 'BoxClosing' ]
		group: 'OpenBox'

	# API

	constructor: (settings) ->
		super()
		@dispatcher = new asyncmachine.Dispatcher
		@debugStates '[manager] '
		@initStates 'Disconnected'

		# # TODO no auto connect 
		@set 'Connecting'

		if settings.repl
			@repl()

	addSearch: (name, update_interval) ->
		@searches.push new SearchAgent this, name, update_interval

	# STATE TRANSITIONS

	Connected_enter: (states) ->
		setTimeout (@setLater 'BoxClosed'), 0

	Connected_Disconnected: -> 
		process.exit()

	Connecting_enter: (states) ->
		data = @settings
		@connection = new ImapConnection(
			username: data.gmail_username,
			password: data.gmail_password,
			host: data.gmail_host || "imap.gmail.com",
			port: 993,
			secure: true
		)
												
		@connection.connect @addLater 'Connected'

	Connecting_exit: (target_states) ->
		if ~target_states.indexOf 'Disconnected'
			yes
			# TODO cleanup

	Connected_exit: ->
		# TODO callback?
		@connection.logout @addLater 'Disconnected'

	BoxOpening_enter ->
		fetch = @addLater 'Fetching'
		if @state 'BoxOpened'
			setTimeout fetch, 0
			return no
		else
			@once('Box.Opened.enter', fetch
		if @box_opening_promise
			@box_opening_promise.reject()
		# TODO try and set to Disconnected on catch
		# Error: Not connected or authenticated
		# TODO support err param to the callback
		@connection.openBox "[Gmail]/All Mail", no, (@addLater 'BoxOpened')
		@box_opening_promise = @last_promise

	BoxOpening_BoxOpening: ->
		# TODO move to boxopened_enter??/
		@once 'Box.Opened.enter', @setLater 'Fetching'

	BoxOpening_exit: ->
		# TODO stop openbox
		promise = @box_opening_promise
		if promise and not promise.isResolved
			promise.reject()

	BoxClosing_enter: ->
		@connection.closeBox @addLater 'BoxClosed'

	BoxOpened_enter: ->
		# TODO Add inner state
		setTimeout( =>
			if not @add 'Fetching'
				@log('Cant set Fetching', @state() )
		, 0)

	Delayed_enter: ->
		# schedule a task
		@delayed_timer = setTimeout @addLater 'Fetching', @minInterval_()

	Delayed_exit: ->
		clearTimeout @delayed_timer

	Fetching_enter: ->
		# Add new search only if there's a free limit.
		if @concurrency.length >= @max_concurrency
			return no
		# TODO skip searches which interval hasn't passed yet
		searches = @searches.sortBy "last_update"
		search = searches.first()
		i = 0
		# Optimise for more justice selection.
		# TODO encapsulate to needsUpdate()
		while search.last_update + search.update_interval > Date.now()
			search = searches[ i++ ]
			if not search
				return no
		@log "activating " + search.name
		# Performe the search
		if @concurrency.some (s) => s.name == search.name
			return no
		@log 'concurrency++'
		@concurrency.push search
		search.add 'FetchingQuery'
		# Subscribe to a finished query
		search.once 'Fetching.Results.exit', =>
#			@concurrency = @concurrency.exclude( search )
			@concurrency = @concurrency.filter (row) =>
				return row isnt search
			@log 'concurrency--'
#			@addsLater( 'HasMonitored', 'Delayed' )
			@addLater 'Delayed'
			@addLater 'HasMonitored'
			@newSearchThread @minInterval_()

	# TODO move to AM
	statesLog_: ->
		if not @log_handler_
			return
		@log_handler_.apply @, arguments

	Fetching_exit: (states, args) ->
		if not ~states.indexOf 'Active'
			# TODO wil appear anytime?
			@log 'cancel fetching'
		if @concurrency.length and not args['force']
			return no
		# Exit from all queries.
		exits = @concurrency.map (search) => search.drop 'Fetching'
		not ~exits.indexOf no

	Fetching_Fetching: @Fetching_enter

	Active_enter: ->
		while @threads.length < @max_concurrency
			@newSearchThread()

	newSearchThread: (delay: number = 0) ->
		task = new asyncmachine.Task
		@threads.push task
		task.schedule =>
			if @state 'BoxOpened'
				@add 'Fetching'
			else if not @add 'BoxOpening'
				@log 'BoxOpening not set', @state()

	# PRIVATES

	minInterval_: ->
		Math.min.apply null, @searches.map (ch) => ch.update_interval

#	repl: BaseClass.prototype.repl;
#	log: BaseClass.prototype.log;

	# TODO FIXME
	repl: ->
		repl = repl.start(
			prompt: "repl> "
			input: process.stdin
			output: process.stdout
		)
		repl.context.this = @

	log: (...msgs) ->
		@log.apply console, msgs

class App extends GmailManager
	Connected_enter: (states) ->
		super()
#		if ( super.Connected_enter( states ) === no )
#			return no
		# TODO support sync inner state change
		setTimeout( =>
			@log 'adding searches'
			@addSearch '*', 1000
			@addSearch 'label:sent', 5000
			@addSearch 'label:T-foo', 5000
			if not @add('Active'
				@log 'cant activate', @state()
		, 0

gmail = new App settings

timeout = =>
	if gmail.state 'Connecting'
		gmail.add 'Disconnected'
	else
		setTimeout gmail.addLater 'Disconnected', 10*1000

setTimeout timeout, 10*1000
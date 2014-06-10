settings = require '../settings'
Imap = require "imap"
repl = require 'repl'
require 'sugar'
asyncmachine = require 'asyncmachine'
am_task = require './asyncmachine-task'
rsvp = require 'rsvp'

Object.merge settings, gmail_max_results: 300

class Query extends am_task.Task
	#	private msg: imap.ImapMessage;

	# Tells that the instance has some monitored messages.
	HasMonitored: {}

	# Aggregating state
	Fetching:
		blocks: ['Idle']

	Idle:
		blocks: ['Fetching']

	FetchingQuery:
		implies: ['Fetching'],
		blocks: ['FetchingResults']

	FetchingResults:
		implies: ['Fetching'],
		blocks: ['FetchingQuery']

	ResultsFetchingError:
		implies: ['Idle']
		blocks: ['FetchingResults']

	FetchingMessage:
		blocks: ['MessageFetched'],
		requires: ['FetchingResults']

	MessageFetched:
		blocks: ['FetchingMessage'],
		requires: ['FetchingResults']

	# Attributes

	active: true
	last_update: 0
	headers:
		bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)'
		struct: yes
	monitored: []		
	connection: null
	name: "*"
	update_interval: 10*1000
	fetching_counter: 0

	constructor: (connection, name, update_interval) ->
		super()
								
		@register 'HasMonitored', 'Fetching', 'Idle', 'FetchingQuery',
			'FetchingResults', 'ResultsFetchingError', 'FetchingMessage',
			'MessageFetched'
								
		@debug '[query]'

		@connection = connection
		@name = name
		@update_interval = update_interval

#	Idle_FetchingQuery: ->
	FetchingQuery_enter: ->
		@last_update = Date.now()
		@log "performing a search for " + @name 
		# TODO addLater???
		@connection.imap.search [ ['X-GM-RAW', @name ] ], (err, results) =>
			@add 'FetchingResults', err, results
		yes

	# TODO unpack args to real arguments
	FetchingQuery_FetchingResults: (states, args) ->
		@log 'got search results'
		# TODO handle err
		err = args[0]
		results = args[1]
		fetch = @connection.imap.fetch results, @headers
		# Subscribe state changes to fetching events.
		# TODO use children tasks for several messages, bind to all
		fetch.on "error", @addLater 'ResultsFetchingError'
		fetch.on "message", (msg) =>
			@fetching_counter++
			@add 'FetchingMessage', msg

#	FetchingMessage_enter( states, params, msg ) {
	# TODO unpack args to real arguments
	FetchingMessage_enter: (states, args) ->
		msg = args[0]
		attrs = null
		body = ''
		# TODO garbage collect these bindings?
		msg.on 'body', (stream, data) =>
			stream.on 'data', (chunk) ->
				body += chunk.toString 'utf8'
			stream.once 'end', ->
				body = Imap.parseHeader body
		msg.once 'attributes', (data) => attrs = data
		msg.once 'end', => @add 'MessageFetched', msg, attrs, body

#	FetchingMessage_MessageFetched( states, params ) {
	# TODO unpack args to real arguments
	FetchingMessage_MessageFetched: (states, args) ->
		msg = args[0]
		attrs = args[1]
		body = args[2]
		id = attrs['x-gm-msgid']
		if not ~@monitored.indexOf id
			# TODO event
			labels = attrs['x-gm-labels'] || []
#			@log "New msg \"#{msg.headers.subject}\" (#{labels})"
			@log "New msg \"#{body.subject}\" (#{labels.join ','})"
			@monitored.push id
			@add 'HasMonitored'
		# TODO drop when children processes are implemented
		--@fetching_counter
		@drop 'FetchingResults' if not @fetching_counter

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

# TODO IDLE state
class Connection extends asyncmachine.AsyncMachine

	# ATTRIBUTES

	queries_running_limit: 3
	queries: []
	imap: null
	box_opening_promise: null
	delayed_timer: null
	queries_running: []
	settings: null
	last_promise: null
				
	# STATES
				
	Disconnected:
		blocks: ['Connected', 'Connecting', 'Disconnecting']

	Disconnecting:
		blocks: ['Connected', 'Connecting', 'Disconnected']

	Connected:
		blocks: ['Connecting', 'Disconnecting', 'Disconnected']
		implies: ['BoxClosed']

	Connecting:
		blocks: ['Connected', 'Disconnecting', 'Disconnected']

	Idle:
		requires: ['Connected']

	Active:
		requires: ['Connected']

	Fetched: {}

	Fetching:
		requires: ['BoxOpened']
		blocks: ['Idle', 'Delayed']

	Delayed:
		requires: ['Active'] 
		blocks: ['Fetching', 'Idle']

	BoxOpening:
		requires: ['Active']
		blocks: ['BoxOpened', 'BoxClosing', 'BoxClosed']
#		group: 'OpenBox'

	BoxOpened:
		depends: ['Connected']
		requires: ['Active']
		blocks: ['BoxOpening', 'BoxClosed', 'BoxClosing']
#		group: 'OpenBox'

	BoxClosing:
		blocks: ['BoxOpened', 'BoxOpening', 'Box']
#		group: 'OpenBox'

	BoxClosed:
#		requires: ['Active']
		blocks: ['BoxOpened', 'BoxOpening', 'BoxClosing']
#		group: 'OpenBox'

	# API

	constructor: (settings) ->
		super()
				
		@settings = settings
								
		@register 'Disconnected', 'Disconnecting', 'Connected', 'Connecting',
			'Idle', 'Active', 'Fetched', 'Fetching', 'Delayed', 'BoxOpening',
			'BoxOpened', 'BoxClosing', 'BoxClosed'
								
		@debug '[connection]'
		# TODO no auto connect 
		@set 'Connecting'

		if settings.repl
			@repl()

	addQuery: (query, update_interval) ->
		# TODO tokenize query?
		@log "Adding query '#{query}'"
		@queries.push new Query @, query, update_interval
		# TODO make it a state
#		if @is 'BoxOpened'
#			@add 'Fetching'
#		else if not @add 'BoxOpening'
#			@log 'BoxOpening not set', @is()

	# STATE TRANSITIONS

#	Connected_enter: (states) -> @set 'BoxClosed'

	Connected_Disconnected: -> 
		process.exit()

	Connecting_enter: (states) ->
		data = @settings
		@imap = new Imap
			user: data.gmail_username
			password: data.gmail_password
			host: data.gmail_host || "imap.gmail.com"
			port: 993
			tls: yes
			debug: console.log if @settings.debug
																								
		@imap.connect()
		@imap.once 'ready', @addLater 'Connected'

	Connecting_exit: (target_states) ->
		if ~target_states.indexOf 'Disconnected'
			yes
			# TODO cleanup

	Connected_exit: -> @imap.end @addLater 'Disconnected'

	BoxOpening_enter: ->
		if @is 'BoxOpened'
			# TODO 0?
			@add 'Fetching', 0
			return no
		else
			@once 'Box.Opened.enter', @addLater 'Fetching'
		if @box_opening_promise
			@box_opening_promise.reject()
		# TODO try and set to Disconnected on catch
		# Error: Not connected or authenticated
		# TODO support err param to the callback
		@imap.openBox "[Gmail]/All Mail", no, (@addLater 'BoxOpened')
		@box_opening_promise = @last_promise
		yes

	BoxOpening_BoxOpening: ->
		# TODO move to boxopened_enter??/
		@once 'Box.Opened.enter', @setLater 'Fetching'
#		yes

	# TODO `promise.reject()` undefined is not a function
#	BoxOpening_exit: ->
#		# TODO stop openbox
#		promise = @box_opening_promise
#		if promise and not promise.isResolved
#			promise.reject()

	BoxClosing_enter: ->
		@imap.closeBox @addLater 'BoxClosed'

	BoxOpened_enter: ->
		if not @add 'Fetching'
			@log 'Cant set Fetching', @is()

	# TODO this doesnt look OK...
	Delayed_enter: ->
		# schedule a task
		@delayed_timer = setTimeout (@addLater 'Fetching'), @minInterval_()

	Delayed_exit: ->
		clearTimeout @delayed_timer

	Fetching_enter: ->
		# Add new search only if there's a free limit.
		return no if @queries_running.length >= @queries_running_limit
		# TODO skip searches which interval hasn't passed yet
		queries = @queries.sortBy "last_update"
		query = queries.first()
		i = 0
		# Optimise for more justice selection.
		# TODO encapsulate to needsUpdate()
		while query.last_update + query.update_interval > Date.now()
			query = queries[ i++ ]
			if not query
				return no
		@log "activating " + query.name
		return no if @queries_running.some (s) => s.name == query.name
		# Performe the search
		@log 'concurrency++'
		@queries_running.push query
		query.add 'FetchingQuery'
		# Subscribe to a finished query
		query.once 'Fetching.Results.exit', =>
	#			@concurrency = @concurrency.exclude( search )
			@queries_running = @queries_running.filter (row) =>
				return (row isnt query)
			@log 'concurrency--'
	#			@addsLater 'HasMonitored', 'Delayed'
			# TODO Delayed?
			# TODO transaction?
			@add ['Delayed', 'HasMonitored']
			# Loop the fetching process
			@add 'Fetching'
		yes

	Fetching_exit: (states, args) ->
		# TODO sugar.js issue?
#		if not states.find 'Active'
		if not ~states.indexOf 'Active'
			# TODO will appear anytime? (?)
			@log 'cancel fetching'
		# TODO fix param and suuport in Disconnected too
		if @queries_running.length and not args?[0].force
			return no
		# Exit from all queries.
		exits = @queries_running.map (query) => query.drop 'Fetching'
		not ~exits.indexOf no

	Fetching_Fetching: @Fetching_enter

	Active_enter: -> @add 'BoxOpening'

	# PRIVATES

	minInterval_: ->
		Math.min.apply null, @queries.map (ch) => ch.update_interval

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

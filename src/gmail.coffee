settings = require '../settings'
Imap = require "imap"
require 'sugar'
asyncmachine = require 'asyncmachine'
am_task = require './asyncmachine-task'
rsvp = require 'rsvp'

Object.merge settings, gmail_max_results: 300

class Message extends am_task.Task

class Query extends asyncmachine.AsyncMachine
#class Query extends am_task.Task
	#	private msg: imap.ImapMessage;

	# Tells that the instance has some monitored messages.
	HasMonitored: {}

	# TODO block in blocked states
	ResultsFetched: 
		blocks: ['FetchingMessage', 'FetchingResults', 'FetchingQuery', 'Fetching']

	# Aggregating state
	Fetching:
		blocks: ['Idle']

	Idle:
		blocks: ['Fetching']

	FetchingQuery:
		implies: ['Fetching'],
		blocks: ['FetchingResults', 'ResultsFetched']

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
	next_update: 0
	headers:
		bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)'
		struct: yes
	monitored: []		
	connection: null
	name: "*"
	update_interval: 10*1000
	
	# TODO type me!
	fetch: null
	# TODO type me!
	msg: null

	constructor: (connection, name, update_interval) ->
		super()
								
		@register 'HasMonitored', 'Fetching', 'Idle', 'FetchingQuery',
			'FetchingResults', 'ResultsFetchingError', 'FetchingMessage',
			'MessageFetched', 'ResultsFetched'
								
		@debug "[query:\"#{name}\"]", 1

		@connection = connection
		@name = name
		@update_interval = update_interval

#	Idle_FetchingQuery: ->
	FetchingQuery_enter: ->
		# TODO set once results are ready???
		@last_update = Date.now()
		@next_update = @last_update + @update_interval
		@log "performing a search for " + @name 
		# TODO addLater???
		@connection.imap.search [ ['X-GM-RAW', @name ] ], (err, results) =>
			@add 'FetchingResults', err, results
		yes

	FetchingQuery_FetchingResults: (states, err, results) ->
		@log 'got search results'
		if not results.length
			@add 'ResultsFetched'
			return yes
		@fetch = @connection.imap.fetch results, @headers
		# Subscribe state changes to fetching events.
		@fetch.on "message", @addLater 'FetchingMessage'
		@fetch.once "error", @addLater 'ResultsFetchingError'
		@fetch.once "end", @addLater 'ResultsFetched'
		
	FetchingResults_exit: ->
		@fetch.unbindAll()
		@fetch = null

	FetchingMessage_enter: (states, msg) ->
		attrs = null
		body_buffer = ''
		body = null
		# TODO garbage collect these bindings?
		@msg.on 'body', (stream, data) =>
			stream.on 'data', (chunk) ->
				body_buffer += chunk.toString 'utf8'
			stream.once 'end', ->
				body = Imap.parseHeader body_buffer
		@msg.once 'attributes', (data) => attrs = data
		@msg.once 'end', =>
			@add 'MessageFetched', msg, attrs, body

	FetchingMessage_exit: ->
		@msg.unbindAll()
		@msg = null

	FetchingMessage_MessageFetched: (states, msg, attrs, body) ->
		id = attrs['x-gm-msgid']
		if not ~@monitored.indexOf id
			# TODO event
			labels = attrs['x-gm-labels'] || []
			@log "New msg \"#{body.subject}\" (#{labels.join ','})"
			@monitored.push id
			@add 'HasMonitored'

	ResultsFetchingError_enter: (err) ->
		@log 'fetching error', err
		@add 'Idle'
		if err
			throw new Error err

# TODO IDLE state
class Connection extends asyncmachine.AsyncMachine

	# ATTRIBUTES

	queries: []
	queries_running: []
	queries_running_limit: 3
	imap: null
	box_opening_promise: null
	query_timer: null
	settings: null
	last_promise: null
				
	# STATES
				
	Disconnected:
		blocks: ['Connected', 'Connecting', 'Disconnecting']

	Disconnecting:
		blocks: ['Connected', 'Connecting', 'Disconnected']

	DisconnectingFetching:
		requires: ['Disconnecting']

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

	# Tells that the instance has some monitored messages.
	HasMonitored: 
		requires: ['Connected', 'BoxOpened']
		
	# TODO Type me!
	box: null

	# API

	constructor: (settings) ->
		super()

		@settings = settings
								
		@register 'Disconnected', 'Disconnecting', 'Connected', 'Connecting',
			'Idle', 'Active', 'Fetched', 'Fetching', 'Delayed', 'BoxOpening',
			'BoxOpened', 'BoxClosing', 'BoxClosed', 'HasMonitored'
								
		@debug '[connection]', 1
		# TODO no auto connect 
		@set 'Connecting'

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

	Connected_exit: ->
		@imap.end @addLater 'Disconnected'

	BoxOpening_enter: ->
		if @is 'BoxOpened'
			@add 'Fetching'
			return no
		else
			@once 'Box.Opened.enter', @addLater 'Fetching'
		if @box_opening_promise
			@box_opening_promise.reject()
		# TODO try and set to Disconnected on catch
		# Error: Not connected or authenticated
		# TODO support err param to the callback
		tick = @clock 'BoxOpening'
		@imap.openBox "[Gmail]/All Mail", no, =>
			@add 'BoxOpened' if @is 'BoxOpening', tick
		@box_opening_promise = @last_promise
		yes

	BoxClosing_enter: ->
		@imap.closeBox @addLater 'BoxClosed'

	BoxOpened_enter: (err, box) ->
		# TODO
#		if err
#			@add 'BoxOpeningError', err
		@box = box
		if not (@add 'Fetching') and not @duringTransition()
			@log "Cant set Fetching (states: #{@is()})"

	Delayed_exit: ->

	# TODO refactor this logic to the Active state ???
	Fetching_enter: ->
		# Add new search only if there's a free limit.
		while @queries_running.length < @queries_running_limit
			# Select the next query (based on last update + interval)
			queries = @queries.sortBy "next_update"
			# Skip active queries
			queries = queries.filter (item) =>
				not @queries_running.some (s) => s.name == item.name
			queries = queries.filter (item) =>
				 not item.next_update or item.next_update < Date.now()
			query = queries.first()
			break if not query
			
			@log "activating #{query.name}"
			# Performe the search
			@log 'concurrency++'
			@queries_running.push query
			query.add 'FetchingQuery'
			# Subscribe to a finished query
			# TODO GC on the exit transition
			query.once 'Results.Fetched.enter', =>
				# @concurrency = @concurrency.exclude( search )
				@queries_running = @queries_running.filter (row) =>
					return (row isnt query)
				@log 'concurrency--'
				# TODO Aggregate HasMonitored from the queries
				# @add ['Delayed', 'HasMonitored']
				@add 'HasMonitored'
				
		# Loop the fetching process
		@query_timer = setTimeout (@addLater 'Fetching'), @minInterval_()
		
	Fetching_exit: (states, force) ->
		# Exit from all queries.
		# TODO utilize some event aggregation util?
		@drop 'Active'
		clearTimeout @query_timer if @query_timer
		return yes if @queries_running.every (query) ->
			query.is 'Idle'
		# TODO manage @queries_running in a better way
		counter = @queries_running.length
		exit = =>
			if --counter is 0
				@add states
		@queries_running.forEach (query) =>
			query.drop 'Fetching'
			query.once 'Idle', exit
		no
		
	Disconnected_enter: (states) ->
		if @any 'Connected', 'Connecting'
			@add 'Disconnecting'
			no
		else if @is 'Disconnecting'
			no
			
	Disconnecting_exit: -> @add 'Disconnected'

	Fetching_Fetching: -> @Fetching_enter.apply @, arguments

	Active_enter: -> @add 'BoxOpening'

	# PRIVATES

	minInterval_: ->
		Math.min.apply null, @queries.map (ch) => ch.update_interval

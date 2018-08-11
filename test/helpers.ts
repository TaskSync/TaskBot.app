///<reference path="../typings/index.d.ts"/>

export const DELAY = 5000
export const scenarios = [0, 1, 2]

import * as assert from 'assert'
import * as google from 'googleapis'
import * as debug from 'debug'
import * as _ from 'lodash'
import { promisifyArray } from 'typed-promisify-tob/index'
import { test_user } from '../config-users'
import { getConfig } from '../src/app/config'
import Connections from '../src/app/connections'
import Logger from '../src/app/logger'
import GmailSync from '../src/google/gmail/sync'
import GTasksSync from '../src/google/tasks/sync'
import RootSync from '../src/sync/root'
import * as delay from 'delay'

import { OAuth2Client } from 'google-auth-library/build/src/auth/oauth2client'

export type Label = google.gmail.v1.Label
export type Thread = google.gmail.v1.Thread
export type Task = google.tasks.v1.Task
export type TaskList = google.tasks.v1.TaskList

export default async function createHelpers() {
  let gtasks: google.tasks.v1.Tasks
  let gmail: google.gmail.v1.Gmail
  let auth: OAuth2Client
  let sync: RootSync
  let gmail_sync: GmailSync
  let gtasks_sync: GTasksSync
  const log_inner = debug('tests')
  const log = (msg, ...rest) => {
    // @ts-ignore
    if (debug.disabled) return
    log_inner(msg, ...rest)
  }

  await initTest()

  return {
    gtasks,
    gmail,
    auth,
    sync,
    gmail_sync,
    gtasks_sync,
    hasLabel,
    listQuery,
    deleteThread,
    getThread,
    listTasklist,
    req,
    truncateQuery,
    truncateGmail,
    truncateGTasks,
    truncateGTasksList,
    syncList,
    syncListScenario,
    getTask,
    addTask,
    patchTask,
    reset,
    labelID,
    modifyLabels,
    printDB,
    deleteTask,
    log
  }

  async function modifyLabels(
    thread_id: string,
    add: string[] = [],
    remove: string[] = []
  ) {
    await req('gmail.users.threads.modify', {
      id: thread_id,
      userId: 'me',
      fields: 'id',
      resource: {
        addLabelIds: add.map(labelID),
        removeLabelIds: remove.map(labelID)
      }
    })
  }

  function hasLabel(thread: google.gmail.v1.Thread, label: string): boolean {
    return thread.messages[0].labelIds.includes(labelID(label))
  }

  async function listQuery(
    query = 'label:!s-next-action'
  ): Promise<google.gmail.v1.ListThreadsResponse> {
    const [list, res] = await req('gmail.users.threads.list', {
      maxResults: 1000,
      q: query,
      userId: 'me',
      // TODO is 'snippet' useful?
      fields: 'nextPageToken,threads(historyId,id)'
    })
    return list
  }

  async function deleteThread(thread_id: string): Promise<true> {
    await req('gmail.users.threads.delete', {
      userId: 'me',
      id: thread_id
    })
    return true
  }

  async function getThread(id: string): Promise<Thread> {
    const [body, res] = await req('gmail.users.threads.get', {
      id,
      userId: 'me',
      metadataHeaders: ['SUBJECT', 'FROM', 'TO'],
      format: 'metadata',
      fields: 'id,historyId,messages(id,labelIds,payload(headers))'
    })
    return body
  }

  async function listTasklist(name = '!next'): Promise<google.tasks.v1.Tasks> {
    const [body] = await req('gtasks.tasks.list', {
      maxResults: 1000,
      tasklist: gtasks_sync.getListByName(name).list.id,
      fields: 'etag,items(id,title,notes,updated,etag,status,parent)',
      showHidden: false
    })
    return body
  }

  function printDB() {
    if (!sync.data) return
    log('\nInternal DB:')
    log(sync.data.toString())
    log('\nAPI DBs:')
    log(gmail_sync.toString())
    log(gtasks_sync.toString())
  }

  async function initTest() {
    disableDebug()
    // init sync
    const logger = new Logger()
    const connections = new Connections(logger)
    const config = getConfig(test_user)
    // disable auto sync
    config.sync_frequency = 10000 * 100
    config.gtasks.sync_frequency = 10000 * 100
    sync = new RootSync(config, logger, connections)
    // disable heartbeat
    sync.state.on('HeartBeat_enter', () => false)
    sync.state.on('Scheduled_enter', () => false)
    // fwd exceptions
    sync.state.on('MergeLimitExceeded_state', () => {
      throw new Error('MergeLimitExceeded')
    })
    sync.state.on('MaxReadsExceeded_state', () => {
      throw new Error('MaxReadsExceeded')
    })
    sync.state.on('MaxWritesExceeded_state', () => {
      throw new Error('MaxWritesExceeded')
    })
    sync.state.on('Exception_state', err => {
      throw err
    })
    const ready_state = sync.state.get('Ready')
    // disable auto start (remove Reading being added by Ready)
    ready_state.add = _.without(ready_state.add, 'Reading')
    // jump to the next tick
    await delay(0)

    // build the API clients and the Auth object
    // TODO extract
    gtasks = google.tasks('v1')
    gmail = google.gmail('v1')
    // @ts-ignore
    auth = new google.auth.OAuth2(
      config.google.client_id,
      config.google.client_secret,
      config.google.redirect_url
    )
    auth.credentials = {
      access_token: config.google.access_token,
      refresh_token: config.google.refresh_token
    }
    // TODO
    // const token = await new Promise(resolve => {
    //   auth.refreshAccessToken((err, token) => {
    //     if (err) {
    //       console.error('refreshAccessToken')
    //       throw new Error(err)
    //     }
    //     resolve(token)
    //   })
    // })
    // console.log(`New access token ${token}`)
    // process.exit()

    // delete all the data
    await truncateGmail()
    await truncateGTasks()

    // init the engine
    sync.state.addNext('Enabled')
    await sync.state.when('Ready')
    gmail_sync = sync.subs.google.subs.gmail
    gtasks_sync = sync.subs.google.subs.tasks

    // treat max reads/writes as an exceptions
    for (const sub of sync.subs_all) {
      sub.state.on('MaxReadsExceeded_state', () => {
        throw new Error('MaxReadsExceeded')
      })
      // treat quota exceeded as an exception
      sub.state.on('QuotaExceeded_state', () => {
        throw new Error('QuotaExceeded')
      })
    }
    for (const sub of sync.subs_all_writers) {
      sub.state.on('MaxWritesExceeded_state', () => {
        throw new Error('MaxWritesExceeded')
      })
    }
    assert(gtasks_sync, 'gtasks sync missing')
    assert(gmail_sync, 'gmail sync missing')
    // trigger sync
    sync.state.add('Syncing')
    log('connected')
    await sync.state.when('WritingDone')
    log('initial sync OK')
    enableDebug()
  }

  // TODO retry on Backend Error
  async function req(method: string, params = {}, options = {}) {
    log(`req ${method}:\n%O`, params)
    if (DELAY) {
      await delay(delay)
    }
    // @ts-ignore
    params.auth = auth
    // prevent JIT from shadowing those
    // @ts-ignore
    void (gmail, gtasks)
    // log(method)
    // @ts-ignore
    options = {
      forever: true,
      options
    }
    // @ts-ignore
    return await promisifyArray(eval(method))(params, options)
  }

  async function truncateQuery(query) {
    const [body, res] = await req('gmail.users.threads.list', {
      maxResults: 1000,
      q: query,
      userId: 'me',
      fields: 'nextPageToken,threads(historyId,id)'
    })

    const threads = body.threads || []
    await Promise.all(
      threads.map(
        async thread =>
          await req('gmail.users.threads.delete', {
            id: thread.id,
            userId: 'me'
          })
      )
    )
  }

  async function truncateGTasks() {
    // get all the lists
    const [body, res] = await req('gtasks.tasklists.list', {})
    const lists = body.items || []
    // delete every list
    await Promise.all(
      lists.map(async (list: TaskList) => {
        // skip the default one
        if (list.title == 'My Tasks') return
        await req('gtasks.tasklists.delete', { tasklist: list.id })
      })
    )
    log('removed all tasks')
  }

  async function truncateGTasksList(name = '!next') {
    const list = gtasks_sync.getListByName(name)
    assert(list, `list doesn't exist`)
    // get all the lists
    const [body, res] = await req('gtasks.tasks.list', {
      tasklist: list.list.id
    })
    const lists = body.items || []
    // delete every list
    await Promise.all(
      lists.map(async (task: TaskList) => {
        await req('gtasks.tasks.delete', {
          tasklist: list.list.id,
          task: task.id
        })
      })
    )
    log('removed all tasks')
  }

  async function truncateGmail() {
    // TODO remove labels
    await Promise.all(
      ['label:all', 'label:trash'].map(
        async query => await truncateQuery(query)
      )
    )
    log('removed all emails')
  }

  /*
   * Scenarios:
   * 0 - gmail & tasks sync simultaneously
   * 1 - gmail syncs x2, then gmail&tasks simultaneously
   * 2 - gmail syncs x2, then gmail&tasks simultaneously
   *   then gmail again
   */
  async function syncListScenario(scenario: number, list = '!next') {
    switch (scenario) {
      default:
        await syncList(true, true, list) // gt
        await syncList(true, false, list) // g
        await syncList(true, true, list) // gt
        break
      case 1:
        await syncList(true, false, list) // g
        await syncList(true, false, list) // g
        await syncList(true, true, list) // gt
        break
      case 2:
        await syncList(true, false, list) // g
        await syncList(true, false, list) // g
        await syncList(true, true, list) // gt
        await syncList(true, false, list) // g
        break
    }
  }

  async function syncList(
    gmail_dirty = true,
    gtasks_dirty = true,
    name = '!next'
  ) {
    // start a selective sync
    if (gtasks_dirty) {
      const list = gtasks_sync.getListByName(name)
      // skip gmail-only lists
      if (list) {
        list.state.add('Dirty')
      }
    }
    gmail_sync.getListByName(name).state.add('Dirty')
    sync.state.add('Syncing')
    await sync.state.when('SyncDone')
  }

  async function getTask(
    task_id: string,
    list: string = '!next'
  ): Promise<google.tasks.v1.Task> {
    const [body, res] = await req('gtasks.tasks.get', {
      tasklist: gtasks_sync.getListByName(list).list.id,
      task: task_id,
      fields: 'id,title,updated,status,notes'
    })
    return body
  }

  /**
   * @returns the ID of the new task
   */
  async function addTask(
    title,
    list = '!next',
    notes = '',
    completed = false,
    parent?: string
  ): Promise<string> {
    const [body, res] = await req('gtasks.tasks.insert', {
      tasklist: gtasks_sync.getListByName(list).list.id,
      fields: 'id',
      parent,
      resource: {
        title,
        notes,
        status: completed ? 'completed' : 'needsAction'
      }
    })
    return body.id
  }

  /**
   * @param id Task ID
   * @param patch Partial Task resource
   * @param list List name (not the ID)
   * @return Task ID
   */
  async function patchTask(
    id,
    patch: Partial<google.tasks.v1.Task>,
    list = '!next'
  ): Promise<string> {
    const [body, res] = await req('gtasks.tasks.patch', {
      tasklist: gtasks_sync.getListByName(list).list.id,
      task: id,
      fields: 'id',
      resource: patch
    })
    return body.id
  }

  // TODO reset exceptions too, maybe clone states from after the inital sync
  async function reset() {
    log('reset')
    disableDebug()
    const task_lists = sync.subs.google.subs.tasks.subs.lists
    // clear all the APIs
    const wait = [truncateGmail()]
    for (const list of task_lists) {
      wait.push(truncateGTasksList(list.config.name))
    }
    await Promise.all(wait)
    // clear the local DB
    sync.data.clear()
    sync.subs.google.subs.gmail.threads.clear()
    for (const list of task_lists) {
      list.tasks = null
    }
    for (const list of sync.subs.google.subs.gmail.subs.lists) {
      list.query.threads = []
    }
    gmail_sync.history_ids = []
    gmail_sync.history_id_latest = null
    gmail_sync.last_sync_time = null
    // drop all outbound states
    sync.state.drop(
      'Scheduled',
      'Syncing',
      'SyncDone',
      'Reading',
      'Writing',
      'ReadingDone',
      'WritingDone'
    )
    await sync.subs_all.map(async sync => {
      sync.state.drop('ReadingDone')
      await sync.state.whenNot('ReadingDone')
    })
    await sync.subs_all_writers.map(async sync => {
      sync.state.drop('WritingDone')
      await sync.state.whenNot('WritingDone')
    })
    await delay(DELAY)
    enableDebug()
  }

  function labelID(name) {
    const id = gmail_sync.getLabelID(name)
    assert(id, `Label '${name}' doesnt exist`)
    return id
  }

  async function deleteTask(id, list = '!next') {
    return await req('gtasks.tasks.delete', {
      tasklist: gtasks_sync.getListByName(list).list.id,
      task: id
    })
  }
}

function disableDebug() {
  // @ts-ignore
  debug.disabled = true
}

function enableDebug() {
  // @ts-ignore
  debug.disabled = false
}

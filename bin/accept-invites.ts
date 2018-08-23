import * as firebase from 'firebase-admin'
import { argv } from 'yargs'
import config from '../config-private'
import { acceptInvites } from '../src/server/google-login'

start()
async function start() {
  const amount = parseInt(argv.amount, 10)
  if (!amount) {
    return console.error('--amount missing')
  }
  if (amount < 1) {
    return console.error('--amount has to be > 1')
  }

  const db = firebase.initializeApp({
    credential: firebase.credential.cert(config.firebase.admin),
    // TODO move to the config
    databaseURL: 'https://gtd-bot.firebaseio.com'
  })
  const accepted = await acceptInvites(config, db, amount)
  console.log(`Accepted ${accepted} invites`)
  process.exit()
}
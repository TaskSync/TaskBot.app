import AsyncMachine from 'asyncmachine'
import { Sync } from './sync'
import { ILabelFilter } from '../types'
import RootSync, { DBRecord } from './root'
import * as clone from 'deepcopy'
import * as moment from 'moment'
// Machine types
import {
  IBind,
  IEmit,
  IJSONStates,
  IState,
  TStates,
  IEmitBase,
  IBindBase
} from '../../typings/machines/sync/sync'

export default class LabelFilterSync extends Sync<
  ILabelFilter,
  TStates,
  IBind,
  IEmit
> {
  state: AsyncMachine<TStates, IBind, IEmit>

  constructor(config: ILabelFilter, public root: RootSync) {
    super(config)
  }

  Reading_state() {
    this.state.add('ReadingDone')
  }

  getState() {
    return super.getState().id('label-filter: ' + this.config.name)
  }

  merge(): number[] {
    let count = 0
    const records = <DBRecord[]>(<any>this.root.data.where(
      this.config.db_query
    ))
    for (const r of records) {
      const before = clone(r)
      const { add, remove } = this.config
      this.log(`Changing labels for '${r.title}'`)
      this.applyLabels(r, { add, remove })
      r.updated = moment().unix()
      this.compareRecord(before, r)
      count++
    }
    return count ? [count] : []
  }
}

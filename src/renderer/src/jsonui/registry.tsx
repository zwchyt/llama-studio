import { defineRegistry } from '@json-render/react'
import { catalog } from './catalog'
import './jsonui.css'

import { GpuUsagePanel } from './components/GpuUsagePanel'
import { MessageCard } from './components/MessageCard'
import { Chart } from './components/Chart'

export const { registry } = defineRegistry(catalog, {
  components: {
    GpuUsagePanel,
    MessageCard,
    Chart,
  },
  actions: {},
})

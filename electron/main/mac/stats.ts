import { cpus, homedir, loadavg, totalmem } from 'node:os'
import type { SystemStats } from '../../../shared/types'
import { exec } from './exec'

export async function systemStats(): Promise<SystemStats> {
  const [mem, disk, batt, load] = await Promise.all([
    memInfo(),
    exec('/bin/df', ['-k', '/'], { timeout: 3_000 }),
    exec('/usr/bin/pmset', ['-g', 'batt'], { timeout: 3_000 }),
    Promise.resolve({ load1: loadAverage(), cores: cpuCount() })
  ])

  const diskMatch = /(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%/.exec(disk.stdout.split('\n')[1] ?? '')
  const diskPercent = diskMatch ? Number(diskMatch[4]) : 0

  const batteryPercent = /(\d{1,3})%/.exec(batt.stdout)
  const onAc = /AC Power/.test(batt.stdout)
  const charging = /charging/i.test(batt.stdout) && !/discharging/i.test(batt.stdout)

  return {
    cpuLoad: Math.round(load.load1 * 100) / 100,
    cores: load.cores,
    memUsedGb: Math.round(mem.usedGb * 10) / 10,
    memTotalGb: Math.round(mem.totalGb * 10) / 10,
    memPercent: Math.round(mem.percent),
    diskPercent,
    batteryPercent: batteryPercent ? Number(batteryPercent[1]) : null,
    charging,
    onAc
  }
}

async function memInfo(): Promise<{ usedGb: number; totalGb: number; percent: number }> {
  const totalBytes = totalMemory()
  const vm = await exec('/usr/bin/vm_stat', [], { timeout: 3_000 })
  const pageSize = Number(/page size of (\d+) bytes/.exec(vm.stdout)?.[1] ?? 4096)
  const pages = (label: string): number => {
    const match = new RegExp(`${label}:\\s+(\\d+)\\.`).exec(vm.stdout)
    return match ? Number(match[1]) : 0
  }
  const availablePages = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')
  const availableBytes = availablePages * pageSize
  const usedBytes = Math.max(0, totalBytes - availableBytes)
  return {
    usedGb: usedBytes / 1024 ** 3,
    totalGb: totalBytes / 1024 ** 3,
    percent: (usedBytes / totalBytes) * 100
  }
}

function totalMemory(): number {
  return totalmem()
}

function cpuCount(): number {
  return cpus().length
}

function loadAverage(): number {
  return loadavg()[0] ?? 0
}

export async function batteryInfo(): Promise<{ percent: number | null; charging: boolean; onAc: boolean }> {
  const batt = await exec('/usr/bin/pmset', ['-g', 'batt'], { timeout: 3_000 })
  const percent = /(\d{1,3})%/.exec(batt.stdout)
  return {
    percent: percent ? Number(percent[1]) : null,
    charging: /charging/i.test(batt.stdout) && !/discharging/i.test(batt.stdout),
    onAc: /AC Power/.test(batt.stdout)
  }
}

export async function outputVolume(): Promise<number | undefined> {
  const result = await exec('/usr/bin/osascript', ['-e', 'output volume of (get volume settings)'], {
    timeout: 2_000
  })
  const value = Number(result.stdout.trim())
  return Number.isFinite(value) ? value : undefined
}

export async function runningApps(): Promise<string[]> {
  // lsappinfo needs no Automation permission, unlike System Events.
  const result = await exec('/usr/bin/lsappinfo', ['list'], { timeout: 3_000 })
  const names = new Set<string>()
  for (const line of result.stdout.split('\n')) {
    const match = /"LSDisplayName"="([^"]+)"/.exec(line)
    if (match?.[1]) names.add(match[1])
  }
  return [...names].sort()
}

export async function frontmostApp(): Promise<string | undefined> {
  // lsappinfo needs no Automation permission, unlike System Events.
  const front = await exec('/usr/bin/lsappinfo', ['front'], { timeout: 2_000 })
  const asn = front.stdout.trim().split('\n')[0]?.trim()
  if (front.code !== 0 || !asn) return undefined
  const info = await exec('/usr/bin/lsappinfo', ['info', '-only', 'name', asn], { timeout: 2_000 })
  const match = /"(?:LSDisplayName|name)"="([^"]+)"/.exec(info.stdout)
  return match?.[1]
}

export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return `${homedir()}${path.slice(1)}`
  return path
}

import { useEffect, useRef } from 'react'
import { useWalletStore, useSettingsStore } from '@/stores'
import { useBalanceHistoryStore } from '@/stores/balanceHistoryStore'
import { activityLogger, tradeLogger } from '@/services/trading'

/**
 * Hook that drives balance snapshots for the BalanceHistoryChart.
 *
 * Three data sources feed the chart:
 *  1. Periodic 60s timer — reads wallet balance (live) or simulated balance (dry-run)
 *  2. ActivityLogger subscription — snapshots immediately on every trade/sell event
 *  3. Historical reconstruction from TradeLogger (on first mount)
 *
 * Call from DashboardView.
 */
export function useBalanceHistory() {
  const balance = useWalletStore((s) => s.balance)
  const dryRun = useSettingsStore((s) => s.dryRun)
  const {
    addSnapshot,
    setInitialBalance,
    setStartTime,
    snapshots,
    initialBalance,
    startTime,
    bulkAddSnapshots,
    recordBuy,
    recordSell,
    syncSimulatedBalance,
    simulatedBalance,
  } = useBalanceHistoryStore()
  const reconstructed = useRef(false)

  // Set start time on first mount
  useEffect(() => {
    if (startTime === 0) {
      setStartTime(Date.now())
    }
  }, [startTime, setStartTime])

  // Seed balance: paper balance in dry run, real wallet balance in live mode.
  const paperBalance = useSettingsStore((s) => s.paperBalance)
  const seededForDryRun = useRef(false)
  useEffect(() => {
    if (dryRun) {
      // Seed paper balance on first mount. The ref prevents re-seeding on every render
      // while still allowing re-seed if the user toggles live→dry run again.
      if (!seededForDryRun.current) {
        syncSimulatedBalance(paperBalance)
        if (initialBalance === 0) {
          setInitialBalance(paperBalance)
        }
        seededForDryRun.current = true
      }
    } else {
      seededForDryRun.current = false
      if (initialBalance === 0 && balance > 0) {
        setInitialBalance(balance)
      }
    }
  }, [balance, dryRun, initialBalance, paperBalance, setInitialBalance, syncSimulatedBalance])

  // In live mode, sync simulated balance to real wallet balance
  useEffect(() => {
    if (!dryRun && balance > 0) {
      syncSimulatedBalance(balance)
    }
  }, [balance, dryRun, syncSimulatedBalance])

  // Reconstruct historical snapshots from trade records (once)
  useEffect(() => {
    if (reconstructed.current) return
    reconstructed.current = true

    const records = tradeLogger.getRecords(5000)
    if (records.length === 0 || initialBalance === 0) return

    const closed = records
      .filter((r) => r.exitTimestamp != null && r.pnlUSD != null)
      .sort((a, b) => a.exitTimestamp! - b.exitTimestamp!)

    if (closed.length === 0) return

    const historical: { timestamp: number; balance: number }[] = []
    let running = initialBalance
    for (const trade of closed) {
      running += trade.pnlUSD!
      historical.push({ timestamp: trade.exitTimestamp!, balance: Math.max(0.01, running) })
    }

    if (historical.length > 0) {
      bulkAddSnapshots(historical)
    }
  }, [initialBalance, bulkAddSnapshots])

  // Subscribe to ActivityLogger — snapshot immediately on every trade/sell
  useEffect(() => {
    const unsubscribe = activityLogger.subscribe((activity) => {
      if (activity.type === 'trade') {
        // Parse dollar cost from message: "BUY YES $1.50" or "BUY NO $2.00 (GTD pending)"
        const costMatch = activity.message.match(/\$(\d+\.?\d*)/)
        const cost = costMatch ? parseFloat(costMatch[1]) : 0
        if (cost > 0) {
          recordBuy(cost)
        }
      } else if (activity.type === 'sell') {
        // Sell events include costBasis and pnlUsd in data
        const data = activity.data as Record<string, unknown> | undefined
        const pnlUsd = (data?.pnlUsd as number) ?? 0
        const costBasis = (data?.costBasis as number) ?? 0

        // The BUY already deducted the cost. Add back full sale proceeds (cost + pnl).
        const proceeds = costBasis + pnlUsd
        if (proceeds > 0) {
          recordSell(proceeds)
        } else if (proceeds < 0) {
          // Net loss exceeds cost basis (shouldn't happen but handle gracefully)
          // Record as buy of the loss amount to decrease balance
          recordBuy(Math.abs(proceeds))
        }
      }
    })

    return unsubscribe
  }, [recordBuy, recordSell])

  // Periodic snapshot every 60s
  useEffect(() => {
    if (balance <= 0 && simulatedBalance <= 0) return

    // Immediate snapshot
    const snapshotBalance = dryRun ? simulatedBalance : balance
    if (snapshotBalance > 0) {
      addSnapshot(snapshotBalance)
    }

    const interval = setInterval(() => {
      const isDry = useSettingsStore.getState().dryRun
      if (isDry) {
        const sim = useBalanceHistoryStore.getState().simulatedBalance
        if (sim > 0) addSnapshot(sim)
      } else {
        const currentBalance = useWalletStore.getState().balance
        if (currentBalance > 0) addSnapshot(currentBalance)
      }
    }, 60_000)

    return () => clearInterval(interval)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return { snapshots, initialBalance, startTime, simulatedBalance }
}

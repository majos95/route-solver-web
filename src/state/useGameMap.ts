import { useState, useEffect, useCallback } from 'react'
import { getPlanetsAndRoutes } from '../api/client'
import { adaptPlanet, adaptRoute } from '../solver/adapters'
import type { Planet, Route } from '../solver/types'
import type { components } from '../api/schema'

export type RawGameMap = components['schemas']['StarDeliveryMap']

export interface GameMap {
  planets: Planet[]
  routes: Route[]
}

interface CacheEntry {
  gameMap: GameMap
  rawMap: RawGameMap
}

// v2: added rawMap to cache entry; v1 entries will fail JSON validation and auto-refetch
const STORAGE_KEY = 'routesolver:gamemap:v2'

export function useGameMap() {
  const [data, setData] = useState<GameMap | null>(null)
  const [rawData, setRawData] = useState<RawGameMap | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    if (retryCount === 0) {
      const cached = sessionStorage.getItem(STORAGE_KEY)
      if (cached) {
        try {
          const entry = JSON.parse(cached) as CacheEntry
          if (!entry.gameMap || !entry.rawMap) throw new Error('stale')
          setData(entry.gameMap)
          setRawData(entry.rawMap)
          setLoading(false)
          return
        } catch {
          sessionStorage.removeItem(STORAGE_KEY)
        }
      }
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    getPlanetsAndRoutes()
      .then(({ data: mapData, error: apiError }) => {
        if (cancelled) return
        if (apiError || !mapData) {
          setError('Failed to load game map')
          return
        }
        const gameMap: GameMap = {
          planets: (mapData.Planets ?? []).map(adaptPlanet),
          routes: (mapData.Routes ?? []).map(adaptRoute),
        }
        const entry: CacheEntry = { gameMap, rawMap: mapData }
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entry))
        setData(gameMap)
        setRawData(mapData)
      })
      .catch(() => { if (!cancelled) setError('Failed to load game map') })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [retryCount])

  const retry = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY)
    setRetryCount((c) => c + 1)
  }, [])

  return { data, rawData, loading, error, retry }
}

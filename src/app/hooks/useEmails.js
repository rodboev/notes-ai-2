// src/app/hooks/useEmails.js

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { parse } from 'best-effort-json-parser'
import { useState, useCallback, useRef, useEffect } from 'react'

const merge = (arrayList1, arrayList2) => [
  ...[]
    .concat(arrayList1, arrayList2)
    .reduce((r, c) => r.set(c.fingerprint, Object.assign(r.get(c.fingerprint) || {}, c)), new Map())
    .values(),
]

const processServerMessage = ({
  event,
  streamingJson,
  allEmails,
  queryClient,
  setEmailsUpdateCounter,
  fingerprint,
}) => {
  const { chunk, status } = JSON.parse(event.data)

  if (status === 'stored') {
    // Handle full response
    const parsedChunk = parse(chunk)
    allEmails = merge(allEmails, parsedChunk?.emails || [])
    if (fingerprint && parsedChunk?.emails?.length > 0) {
      queryClient.setQueryData(['email', fingerprint], parsedChunk.emails[0])
    }
  } else if (status === 'streaming') {
    // Handle streaming data
    streamingJson += chunk
    const parsedJson = parse(streamingJson.trim())
    const validEmails =
      parsedJson?.emails?.filter((email) => email.fingerprint?.length === 40) || []

    if (fingerprint) {
      if (validEmails.length > 0) {
        queryClient.setQueryData(['email', fingerprint], validEmails[0])
      }
    } else {
      allEmails = merge(allEmails, validEmails)
      // Update the query data after each merge
      queryClient.setQueryData(['emails'], allEmails)
      setEmailsUpdateCounter?.((prev) => prev + 1)
    }
  } else if (status === 'streaming-object-complete') {
    // We are clearing the previous streamed object here so adjacent objects in the response can be parsed separately
    streamingJson = ''
  } else if (status === 'complete' || status === 'error') {
    return {
      status,
      allEmails,
      streamingJson,
      error: status === 'error' ? new Error(chunk?.error || 'Unknown error') : null,
    }
  }

  return { status, allEmails, streamingJson, error: null }
}

const createEventSourceHandler = ({
  url,
  queryClient,
  setEmailsUpdateCounter,
  fingerprint,
  signal,
}) => {
  return new Promise((resolve, reject) => {
    let allEmails = [],
      streamingJson = ''
    const eventSource = new EventSource(url)

    const cleanup = () => {
      eventSource.close()
      setEmailsUpdateCounter(0) // Reset counter when request is aborted or completed
    }

    signal.addEventListener('abort', () => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    })

    const handleMessage = (event) => {
      const result = processServerMessage({
        event,
        streamingJson,
        allEmails,
        queryClient,
        setEmailsUpdateCounter,
        fingerprint,
      })
      streamingJson = result.streamingJson
      allEmails = result.allEmails

      if (result.status === 'complete') {
        cleanup()
        resolve(fingerprint ? queryClient.getQueryData(['email', fingerprint]) : allEmails)
      } else if (result.status === 'error') {
        cleanup()
        reject(result.error)
      }
    }

    eventSource.onmessage = handleMessage
    eventSource.onerror = (error) => {
      cleanup()
      reject(error)
    }
  })
}

const handleAbortError = (error) => {
  if (error.name === 'AbortError') {
    console.log('Request was aborted')
    return []
  }
  throw error
}

export const useEmails = (notes) => {
  const queryClient = useQueryClient()
  const [emailsUpdateCounter, setEmailsUpdateCounter] = useState(0)
  const abortControllerRef = useRef(null)

  useEffect(() => {
    // Cleanup function to abort ongoing requests when component unmounts or notes change
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [notes])

  const fetchEmails = useCallback(async () => {
    if (!notes?.length) return []

    // Abort previous request if it exists
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    // Create new AbortController for this request
    abortControllerRef.current = new AbortController()

    const fingerprints = notes.map((note) => note.fingerprint).join(',')
    const url = `/api/emails?fingerprints=${fingerprints}`

    try {
      const emails = await createEventSourceHandler({
        url,
        queryClient,
        setEmailsUpdateCounter,
        signal: abortControllerRef.current.signal,
      })
      return emails
    } catch (error) {
      return handleAbortError(error)
    }
  }, [notes, queryClient])

  const query = useQuery({
    queryKey: ['emails', notes],
    queryFn: fetchEmails,
    enabled: !!notes?.length,
    staleTime: 60000, // Consider data fresh for 1 minute
    cacheTime: 3600000, // Keep unused data in cache for 1 hour
  })

  return { ...query, emailsUpdateCounter }
}

export const useSingleEmail = (fingerprint) => {
  const queryClient = useQueryClient()
  const abortControllerRef = useRef(null)

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [fingerprint])

  const fetchSingleEmail = useCallback(async () => {
    if (!fingerprint) return null

    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    abortControllerRef.current = new AbortController()

    const url = `/api/emails?fingerprint=${fingerprint}`
    try {
      return await createEventSourceHandler({
        url,
        queryClient,
        fingerprint,
        signal: abortControllerRef.current.signal,
      })
    } catch (error) {
      return handleAbortError(error)
    }
  }, [fingerprint, queryClient])

  const query = useQuery({
    queryKey: ['email', fingerprint],
    queryFn: fetchSingleEmail,
    enabled: false,
  })

  return { ...query, refreshEmail: query.refetch }
}

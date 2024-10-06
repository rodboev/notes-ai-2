'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { RealtimeClient } from '@openai/realtime-api-beta'
import { WavRecorder, WavStreamPlayer } from '@/app/lib/wavtools'
import { instructions } from '@/app/voice/conversation_config'
import Nav from '../components/Nav'
import { Phone, PhoneOff } from 'lucide-react'

const ConnectButton = ({ onClick, isConnected, disabled }) => {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-4 py-2 pr-5 ${
        isConnected ? 'bg-neutral-500 hover:bg-neutral-600' : 'hover:bg-teal-600 bg-teal-500'
      } flex items-center font-bold text-white ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      {!isConnected ? (
        <>
          <Phone className="mr-3 h-4 w-4" />
          <span>Start call</span>
        </>
      ) : (
        <>
          <PhoneOff className="mr-2 h-4 w-4" />
          <span>End call</span>
        </>
      )}
    </button>
  )
}

const LOCAL_RELAY_SERVER_URL = 'ws://localhost:49152'

export default function VoiceChat() {
  const [isConnected, setIsConnected] = useState(false)
  const [items, setItems] = useState([])
  const [isRecording, setIsRecording] = useState(false)
  const [canPushToTalk, setCanPushToTalk] = useState(false)

  const wavRecorderRef = useRef(new WavRecorder({ sampleRate: 24000 }))
  const wavStreamPlayerRef = useRef(new WavStreamPlayer({ sampleRate: 24000 }))
  const clientRef = useRef(new RealtimeClient({ url: LOCAL_RELAY_SERVER_URL }))

  const connectConversation = useCallback(async () => {
    const client = clientRef.current
    const wavRecorder = wavRecorderRef.current
    const wavStreamPlayer = wavStreamPlayerRef.current

    setIsConnected(true)
    setItems(client.conversation.getItems())

    await wavRecorder.begin()
    await wavStreamPlayer.connect()

    await client.connect()
    client.sendUserMessageContent([
      {
        type: 'input_text',
        text: 'Hello!',
      },
    ])

    if (client.getTurnDetectionType() === 'server_vad') {
      await wavRecorder.record((data) => client.appendInputAudio(data.mono))
    }

    // Start in VAD mode by default
    await changeTurnEndType('server_vad')
  }, [])

  const disconnectConversation = useCallback(async () => {
    setIsConnected(false)
    setItems([])

    const client = clientRef.current
    client.disconnect()

    const wavRecorder = wavRecorderRef.current
    await wavRecorder.end()

    // Reset the WavRecorder
    wavRecorderRef.current = new WavRecorder({ sampleRate: 24000 })

    const wavStreamPlayer = wavStreamPlayerRef.current
    await wavStreamPlayer.interrupt()
  }, [])

  const startRecording = async () => {
    setIsRecording(true)
    const client = clientRef.current
    const wavRecorder = wavRecorderRef.current
    const wavStreamPlayer = wavStreamPlayerRef.current
    const trackSampleOffset = await wavStreamPlayer.interrupt()
    if (trackSampleOffset?.trackId) {
      const { trackId, offset } = trackSampleOffset
      await client.cancelResponse(trackId, offset)
    }
    await wavRecorder.record((data) => client.appendInputAudio(data.mono))
  }

  const stopRecording = async () => {
    setIsRecording(false)
    const client = clientRef.current
    const wavRecorder = wavRecorderRef.current
    await wavRecorder.pause()
    client.createResponse()
  }

  const changeTurnEndType = async (value) => {
    const client = clientRef.current
    const wavRecorder = wavRecorderRef.current
    if (value === 'none' && wavRecorder.getStatus() === 'recording') {
      await wavRecorder.pause()
    }
    client.updateSession({
      turn_detection: value === 'none' ? null : { type: 'server_vad' },
    })
    if (value === 'server_vad' && client.isConnected()) {
      await wavRecorder.record((data) => client.appendInputAudio(data.mono))
    }
    setCanPushToTalk(value === 'none')
  }

  useEffect(() => {
    const client = clientRef.current
    const wavStreamPlayer = wavStreamPlayerRef.current

    client.updateSession({ instructions })
    client.updateSession({ voice: 'echo' })
    client.updateSession({ input_audio_transcription: { model: 'whisper-1' } })

    client.on('error', (event) => console.error(event))
    client.on('conversation.interrupted', async () => {
      const trackSampleOffset = await wavStreamPlayer.interrupt()
      if (trackSampleOffset?.trackId) {
        const { trackId, offset } = trackSampleOffset
        await client.cancelResponse(trackId, offset)
      }
    })
    client.on('conversation.updated', async ({ item, delta }) => {
      const items = client.conversation.getItems()
      if (delta?.audio) {
        wavStreamPlayer.add16BitPCM(delta.audio, item.id)
      }
      setItems(items)
    })

    setItems(client.conversation.getItems())

    return () => {
      client.reset()
    }
  }, [])

  return (
    <>
      <Nav />
      <div className="flex h-dvh max-w-full snap-y snap-mandatory flex-col items-center justify-center overflow-y-scroll pb-8 pt-20">
        <div className="m-4 h-full w-1/2 min-w-96 overflow-y-auto border p-4">
          {items.map((item) => (
            <div
              key={item.id}
              className={`mb-2 ${item.role === 'assistant' ? 'text-blue-600' : 'text-green-600'}`}
            >
              <strong>{item.role === 'assistant' ? 'Jerry: ' : 'Alex: '}</strong>
              {item.formatted.transcript || item.formatted.text}
            </div>
          ))}
        </div>
        {!isConnected ? (
          <ConnectButton onClick={connectConversation} isConnected={false} disabled={false} />
        ) : (
          <ConnectButton onClick={disconnectConversation} isConnected={true} disabled={false} />
        )}
      </div>
    </>
  )
}

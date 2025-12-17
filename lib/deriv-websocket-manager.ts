"use client"

type MessageHandler = (message: any) => void

interface TickData {
  quote: number
  lastDigit: number
  epoch: number
  symbol: string
}

export class DerivWebSocketManager {
  private static instance: DerivWebSocketManager | null = null
  private ws: WebSocket | null = null
  private messageHandlers: Map<string, MessageHandler[]> = new Map()
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private reconnectDelay = 2000
  private heartbeatInterval: NodeJS.Timeout | null = null
  private lastMessageTime = Date.now()
  private messageQueue: any[] = []
  private subscriptions: Map<string, string> = new Map()
  private isConnecting = false

  private constructor() {}

  public static getInstance(): DerivWebSocketManager {
    if (!DerivWebSocketManager.instance) {
      DerivWebSocketManager.instance = new DerivWebSocketManager()
    }
    return DerivWebSocketManager.instance
  }

  public async connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      console.log("[v0] WebSocket already connected or connecting")
      return
    }

    if (this.isConnecting) {
      console.log("[v0] Connection already in progress")
      return
    }

    this.isConnecting = true

    return new Promise((resolve, reject) => {
      try {
        const wsUrl = "wss://ws.derivws.com/websockets/v3?app_id=106629"
        console.log("[v0] Connecting to Deriv WebSocket:", wsUrl)
        
        this.ws = new WebSocket(wsUrl)

        this.ws.onopen = () => {
          console.log("[v0] WebSocket connected successfully")
          this.reconnectAttempts = 0
          this.isConnecting = false
          this.startHeartbeat()
          this.processMessageQueue()
          resolve()
        }

        this.ws.onmessage = (event) => {
          this.lastMessageTime = Date.now()
          const message = JSON.parse(event.data)
          this.routeMessage(message)
        }

        this.ws.onerror = (error) => {
          console.error("[v0] WebSocket error:", error)
          this.isConnecting = false
          reject(error)
        }

        this.ws.onclose = () => {
          console.log("[v0] WebSocket closed")
          this.isConnecting = false
          this.stopHeartbeat()
          this.handleReconnect()
        }
      } catch (error) {
        this.isConnecting = false
        reject(error)
      }
    })
  }

  private handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[v0] Max reconnect attempts reached")
      return
    }

    this.reconnectAttempts++
    const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts)
    console.log(`[v0] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)

    setTimeout(() => {
      this.connect().catch((error) => {
        console.error("[v0] Reconnection failed:", error)
      })
    }, delay)
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatInterval = setInterval(() => {
      const timeSinceLastMessage = Date.now() - this.lastMessageTime

      if (timeSinceLastMessage > 10000) {
        console.warn("[v0] No messages received for 10 seconds, reconnecting...")
        this.ws?.close()
        return
      }

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ ping: 1 })
      }
    }, 8000)
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  private processMessageQueue() {
    while (this.messageQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      const message = this.messageQueue.shift()
      this.ws.send(JSON.stringify(message))
    }
  }

  public send(message: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
    } else {
      console.log("[v0] WebSocket not ready, queueing message")
      this.messageQueue.push(message)
    }
  }

  private routeMessage(message: any) {
    if (message.msg_type === "tick") {
      const handlers = this.messageHandlers.get("tick") || []
      handlers.forEach((handler) => handler(message))
    } else if (message.msg_type === "candles") {
      const handlers = this.messageHandlers.get("candles") || []
      handlers.forEach((handler) => handler(message))
    } else if (message.msg_type === "active_symbols") {
      const handlers = this.messageHandlers.get("active_symbols") || []
      handlers.forEach((handler) => handler(message))
    } else if (message.error) {
      console.error("[v0] API Error:", message.error)
      const handlers = this.messageHandlers.get("error") || []
      handlers.forEach((handler) => handler(message))
    } else if (message.msg_type === "ping") {
      this.send({ pong: 1 })
    }
  }

  public on(event: string, handler: MessageHandler) {
    if (!this.messageHandlers.has(event)) {
      this.messageHandlers.set(event, [])
    }
    this.messageHandlers.get(event)!.push(handler)
  }

  public off(event: string, handler: MessageHandler) {
    const handlers = this.messageHandlers.get(event)
    if (handlers) {
      const index = handlers.indexOf(handler)
      if (index > -1) {
        handlers.splice(index, 1)
      }
    }
  }

  public async subscribeTicks(symbol: string, callback: (tick: TickData) => void): Promise<string> {
    const requestId = `tick_${symbol}_${Date.now()}`

    const handler = (message: any) => {
      if (message.tick && message.subscription?.id === requestId) {
        const quote = message.tick.quote
        const lastDigit = this.extractLastDigit(quote)
        
        callback({
          quote,
          lastDigit,
          epoch: message.tick.epoch,
          symbol: message.tick.symbol,
        })
      }
    }

    this.on("tick", handler)

    this.send({
      ticks: symbol,
      subscribe: 1,
      req_id: requestId,
    })

    this.subscriptions.set(requestId, symbol)
    return requestId
  }

  public extractLastDigit(quote: number): number {
    const quoteStr = quote.toString().replace(".", "")
    const lastChar = quoteStr[quoteStr.length - 1]
    const digit = parseInt(lastChar, 10)
    
    if (isNaN(digit)) return 0
    return digit
  }

  public async unsubscribe(subscriptionId: string) {
    this.send({ forget: subscriptionId })
    this.subscriptions.delete(subscriptionId)
  }

  public async unsubscribeAll() {
    this.send({ forget_all: ["ticks", "candles"] })
    this.subscriptions.clear()
  }

  public async getActiveSymbols(): Promise<Array<{ symbol: string; display_name: string }>> {
    return new Promise((resolve) => {
      const handler = (message: any) => {
        if (message.active_symbols) {
          this.off("active_symbols", handler)
          resolve(
            message.active_symbols.map((s: any) => ({
              symbol: s.symbol,
              display_name: s.display_name,
            }))
          )
        }
      }

      this.on("active_symbols", handler)
      this.send({
        active_symbols: "brief",
        product_type: "basic",
      })
    })
  }

  public isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  public disconnect() {
    this.stopHeartbeat()
    this.unsubscribeAll()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }
}

export const derivWebSocket = DerivWebSocketManager.getInstance()

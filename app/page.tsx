"use client";

import React, { useState, useEffect, useRef } from 'react';
import { Client } from '@stomp/stompjs';
import SockJS from 'sockjs-client';
import Header from './components/Header';
import ConnectionConfig from './components/ConnectionConfig';
import SubscribeSection from './components/SubscribeSection';
import PublishMessage from './components/PublishMessage';
import LogPanel from './components/LogPanel';
import DisconnectConfirm from './components/DisconnectConfirm';
import { LogEntry } from './components/types';
import { AgentWebSocket } from './lib/AgentWebSocket';
import { isLocalAgentAvailable, shouldUseAgent, isRunningOnLocalhost } from './lib/localAgent';

export default function StompDebugger() {
  // Connection State
  const [url, setUrl] = useState('http://localhost:8080/ws/chat');
  const [token, setToken] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [client, setClient] = useState<Client | null>(null);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [agentAvailable, setAgentAvailable] = useState<boolean | null>(null); // null = checking

  // Messaging State
  const [subscribeDest, setSubscribeDest] = useState('/user/queue/messages');
  const [subscriptions, setSubscriptions] = useState<string[]>([]);
  const [messageCounters, setMessageCounters] = useState<{ [key: string]: number }>({});
  const [sendDest, setSendDest] = useState('/app/chat.send');
  const [messageBody, setMessageBody] = useState('{\n  "receiverId": 7,\n  "content": "Hello world!"\n}');

  // Log State
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Fix global is not defined for SockJS in Next.js
  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).global = window;
    }
  }, []);

  // Detect Local Agent extension on mount
  useEffect(() => {
    if (isRunningOnLocalhost()) {
      // Running locally, agent is not needed
      setAgentAvailable(null);
      return;
    }
    // On Vercel or production: detect agent
    const detectAgent = async () => {
      // Small delay to let content script inject
      await new Promise(resolve => setTimeout(resolve, 300));
      const available = await isLocalAgentAvailable();
      setAgentAvailable(available);
      if (available) {
        addLog('info', '🔌 Stomp Local Agent extension detected!');
      } else {
        addLog('info', '⚠️ Stomp Local Agent extension not detected. Install the extension to connect to localhost.');
      }
    };
    detectAgent();
  }, []);

  // Auto scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const addLog = (type: LogEntry['type'], content: string, destination?: string) => {
    const newLog: LogEntry = {
      id: Math.random().toString(36).substring(7),
      timestamp: new Date().toLocaleTimeString(),
      type,
      content,
      destination
    };
    setLogs(prev => [...prev.slice(-99), newLog]); // Keep last 100 logs
  };

  const buildBrokerUrl = (inputUrl: string): string => {
    if (inputUrl.startsWith('https')) {
      return inputUrl.replace('https', 'wss');
    } else if (inputUrl.startsWith('http')) {
      return inputUrl.replace('http', 'ws');
    }
    return inputUrl;
  };

  const validateUrl = (inputUrl: string): { valid: boolean; error?: string } => {
    const trimmed = inputUrl.trim();
    
    if (!trimmed) {
      return { valid: false, error: 'URL không được để trống' };
    }
    
    if (!trimmed.match(/^https?:\/\//)) {
      return { valid: false, error: 'URL phải bắt đầu bằng http:// hoặc https://' };
    }

    try {
      new URL(trimmed);
      return { valid: true };
    } catch {
      return { valid: false, error: 'URL không hợp lệ' };
    }
  };

  const connect = () => {
    // Validate URL
    const validation = validateUrl(url);
    if (!validation.valid) {
      addLog('error', `✗ Lỗi URL: ${validation.error}`);
      alert(`❌ ${validation.error}\n\nVí dụ: http://localhost:8080/ws/chat`);
      return;
    }

    if (client) {
      client.deactivate();
    }

    const useAgent = shouldUseAgent(url);
    const brokerURL = buildBrokerUrl(url);
    
    addLog('info', `Đang kết nối tới ${url}...`);
    addLog('info', `[DEBUG] WebSocket URL: ${brokerURL}`);
    if (useAgent) {
      addLog('info', `[DEBUG] Sử dụng Local Agent extension proxy`);
    } else if (url.startsWith('http')) {
      addLog('info', `[DEBUG] Sử dụng SockJS fallback`);
    }

    // Check if agent is needed but not available
    if (useAgent && !agentAvailable) {
      addLog('error', '✗ Cần cài đặt Stomp Local Agent extension để kết nối tới localhost từ Vercel.');
      addLog('info', '💡 Gợi ý: Cài extension từ thư mục stomp-local-agent/ → chrome://extensions → Load unpacked');
      return;
    }

    const stompClient = new Client({
      brokerURL: brokerURL,
      connectHeaders: {
        'Authorization': token ? `Bearer ${token}` : '',
      },
      debug: (str) => {
        console.log('[STOMP Debug]', str);
      },
      reconnectDelay: 0,
      heartbeatIncoming: 4000,
      heartbeatOutgoing: 4000,
    });

    // Use Agent WebSocket proxy when on Vercel targeting localhost
    if (useAgent) {
      stompClient.webSocketFactory = () => {
        const agentWs = new AgentWebSocket(url);
        // Hook reconnect callbacks for UI feedback
        agentWs.onreconnecting = (event) => {
          addLog('info', `🔄 Reconnecting... attempt ${event.attempt}/${event.maxAttempts} (retry in ${Math.round(event.delay / 1000)}s)`);
        };
        agentWs.onreconnected = () => {
          addLog('info', '✓ Reconnected successfully!');
        };
        return agentWs as any;
      };
    }
    // Fallback to SockJS if it's an http URL (running locally)
    else if (url.startsWith('http')) {
      stompClient.webSocketFactory = () => {
        return new SockJS(url) as any;
      };
    }

    stompClient.onConnect = (frame) => {
      setIsConnected(true);
      addLog('info', '✓ Kết nối thành công!');
      setClient(stompClient);
    };

    stompClient.onStompError = (frame) => {
      const errorMsg = frame.headers['message'] || 'Unknown error';
      addLog('error', `✗ STOMP Error: ${errorMsg}`);
      stompClient.deactivate();
      setIsConnected(false);
      setClient(null);
    };

    stompClient.onWebSocketError = (error) => {
      const errorMsg = error instanceof Error ? error.message : String(error);
      addLog('error', `✗ WebSocket Error: ${errorMsg}`);
      
      // Kiểm tra lỗi cụ thể
      if (errorMsg.includes('404') || errorMsg.includes('static resource')) {
        addLog('error', '💡 Gợi ý: Path WebSocket có thể không chính xác. Kiểm tra lại URL endpoint.');
      } else if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('Connection refused')) {
        addLog('error', '💡 Gợi ý: Server không thể kết nối. Đảm bảo server đang chạy.');
      }
      
      // Khi dùng Agent proxy: KHÔNG deactivate STOMP — để extension tự reconnect.
      // Nếu deactivate ở đây, STOMP sẽ gọi close() → gửi WS_CLOSE → kill reconnect.
      if (!useAgent) {
        stompClient.deactivate();
        setIsConnected(false);
        setClient(null);
      }
    };

    stompClient.onWebSocketClose = () => {
      setIsConnected(false);
      setClient(null);
      if (!useAgent) {
        addLog('error', '✗ WebSocket bị đóng. Kết nối không thành công.');
      }
    };

    stompClient.activate();
  };

  const disconnect = async () => {
    if (!client) return;
    
    setIsDisconnecting(true);
    try {
      // Hủy tất cả subscriptions
      subscriptions.forEach(dest => {
        try {
          const subscription = client.subscribe(dest, () => {});
          subscription?.unsubscribe();
        } catch (e) {
          console.log(`Failed to unsubscribe from ${dest}`);
        }
      });

      // Đợi một chút trước khi deactivate
      await new Promise(resolve => setTimeout(resolve, 500));

      client.deactivate();
      setIsConnected(false);
      setClient(null);
      setSubscriptions([]);
      setMessageCounters({});
      addLog('info', 'Đã hủy kết nối thành công. Tất cả subscriptions đã bị xóa.');
      setShowDisconnectConfirm(false);
    } catch (err) {
      addLog('error', `Lỗi khi hủy kết nối: ${err}`);
    } finally {
      setIsDisconnecting(false);
    }
  };

  const handleDisconnectClick = () => {
    if (isConnected) {
      setShowDisconnectConfirm(true);
    }
  };

  const unsubscribe = (destination: string) => {
    if (!client) return;
    
    try {
      const subscription = client.subscribe(destination, () => {});
      subscription?.unsubscribe();
      setSubscriptions(subscriptions.filter(s => s !== destination));
      setMessageCounters(prev => {
        const updated = { ...prev };
        delete updated[destination];
        return updated;
      });
      addLog('info', `Đã hủy subscribe: ${destination}`);
    } catch (err) {
      addLog('error', `Lỗi khi hủy subscribe ${destination}: ${err}`);
    }
  };

  const subscribe = () => {
    if (!client || !isConnected) return;

    if (subscriptions.includes(subscribeDest)) {
      alert('Destination này đã được subscribe!');
      return;
    }

    client.subscribe(subscribeDest, (message) => {
      addLog('received', message.body, subscribeDest);
      // Increments message counter
      setMessageCounters(prev => ({
        ...prev,
        [subscribeDest]: (prev[subscribeDest] || 0) + 1
      }));
    });

    setSubscriptions([...subscriptions, subscribeDest]);
    setMessageCounters(prev => ({
      ...prev,
      [subscribeDest]: 0
    }));
    addLog('info', `Đã subscribe destination: ${subscribeDest}`);
  };

  const sendMessage = () => {
    if (!client || !isConnected) return;

    try {
      // Validate JSON
      JSON.parse(messageBody);

      client.publish({
        destination: sendDest,
        body: messageBody,
      });

      addLog('sent', messageBody, sendDest);
    } catch (e) {
      alert('Nội dung không phải là JSON hợp lệ!');
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-200 p-4 font-mono text-sm">
      <div className="max-w-7xl mx-auto space-y-4">
        
        {/* Header */}
        <Header isConnected={isConnected} agentAvailable={agentAvailable} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          
          {/* Settings Side */}
          <div className="lg:col-span-1 space-y-4 text-xs">
            
            {/* Connection Config */}
            <ConnectionConfig
              url={url}
              setUrl={setUrl}
              token={token}
              setToken={setToken}
              isConnected={isConnected}
              isDisconnecting={isDisconnecting}
              onConnect={connect}
              onDisconnect={handleDisconnectClick}
              validateUrl={validateUrl}
            />

            {/* Subscriptions */}
            <SubscribeSection
              subscribeDest={subscribeDest}
              setSubscribeDest={setSubscribeDest}
              subscriptions={subscriptions}
              messageCounters={messageCounters}
              isConnected={isConnected}
              onSubscribe={subscribe}
              onUnsubscribe={unsubscribe}
            />

            {/* Publish Message */}
            <PublishMessage
              sendDest={sendDest}
              setSendDest={setSendDest}
              messageBody={messageBody}
              setMessageBody={setMessageBody}
              isConnected={isConnected}
              onSend={sendMessage}
            />
          </div>

          {/* Log Panel */}
          <LogPanel
            logs={logs}
            onClear={() => setLogs([])}
            logEndRef={logEndRef}
          />
        </div>
      </div>

      {/* Confirmation Dialog */}
      <DisconnectConfirm
        showConfirm={showDisconnectConfirm}
        isDisconnecting={isDisconnecting}
        url={url}
        subscriptionCount={subscriptions.length}
        onCancel={() => setShowDisconnectConfirm(false)}
        onConfirm={disconnect}
      />
    </div>
  );
}

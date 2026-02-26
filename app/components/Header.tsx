import React from 'react';
import { Wifi, WifiOff, Plug, PlugZap } from 'lucide-react';

interface HeaderProps {
  isConnected: boolean;
  agentAvailable: boolean | null; // null = not needed (running on localhost)
}

export default function Header({ isConnected, agentAvailable }: HeaderProps) {
  return (
    <header className="flex items-center justify-between bg-neutral-900 p-4 border border-neutral-800 rounded-lg">
      <div className="flex items-center gap-3">
        <div
          className={`p-2 rounded-full ${
            isConnected
              ? 'bg-emerald-500/10 text-emerald-500'
              : 'bg-rose-500/10 text-rose-500'
          }`}
        >
          {isConnected ? <Wifi size={24} /> : <WifiOff size={24} />}
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white">KnowHub STOMP Debugger</h1>
          <p className="text-neutral-500 text-xs">Real-time WebSocket Testing Tool</p>
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs">
        {/* Agent Status Badge */}
        {agentAvailable !== null && (
          <div
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border ${
              agentAvailable
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : 'bg-amber-500/10 border-amber-500/30 text-amber-400'
            }`}
            title={
              agentAvailable
                ? 'Stomp Local Agent extension is active'
                : 'Install the extension to connect to localhost'
            }
          >
            {agentAvailable ? <PlugZap size={12} /> : <Plug size={12} />}
            <span className="text-[10px] font-medium uppercase tracking-wider">
              {agentAvailable ? 'Agent' : 'No Agent'}
            </span>
          </div>
        )}
        <span className={isConnected ? 'text-emerald-500' : 'text-rose-500'}>
          {isConnected ? 'CONNECTED' : 'DISCONNECTED'}
        </span>
      </div>
    </header>
  );
}

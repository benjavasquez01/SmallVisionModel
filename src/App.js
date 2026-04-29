import React, { useState } from 'react';
import './App.css';
import VisionAnalyzer from './components/VisionAnalyzer';
import About from './components/About';
import BlindAssistant from './components/BlindAssistant';

function App() {
  const [page, setPage] = useState('home');

  if (page === 'assistant') {
    return <BlindAssistant onShowAbout={() => setPage('about')} />;
  }

  if (page === 'about') {
    return <About onBack={() => setPage('home')} />;
  }

  if (page === 'analyzer') {
    return <VisionAnalyzer onShowAbout={() => setPage('about')} />;
  }

  // Home — choose mode
  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ color: '#00897B', marginBottom: 8, textAlign: 'center' }}>Privacy-First Vision AI</h1>
      <p style={{ color: '#666', marginBottom: 40, textAlign: 'center', maxWidth: 400 }}>
        All AI runs in your browser. Nothing is sent to any server.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%', maxWidth: 360 }}>
        <ModeCard
          icon="👁️"
          title="Blind Assistant"
          desc="Real-time camera analysis with spoken descriptions. Detects obstacles and traffic lights."
          color="#00BFA5"
          onClick={() => setPage('assistant')}
        />
        <ModeCard
          icon="🖼️"
          title="Image Analyzer"
          desc="Upload an image and ask questions about it."
          color="#5C6BC0"
          onClick={() => setPage('analyzer')}
        />
        <button
          onClick={() => setPage('about')}
          style={{ padding: '10px 0', background: 'transparent', color: '#00897B', border: '2px solid #00897B', borderRadius: 10, cursor: 'pointer', fontWeight: 600, fontSize: 14 }}
        >
          ℹ️ About & Capabilities
        </button>
      </div>
    </div>
  );
}

function ModeCard({ icon, title, desc, color, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: '#fff', border: `2px solid ${color}`, borderRadius: 12,
        padding: '20px 18px', cursor: 'pointer', textAlign: 'left',
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)', transition: 'transform 0.15s',
      }}
      onMouseOver={e => e.currentTarget.style.transform = 'scale(1.02)'}
      onMouseOut={e => e.currentTarget.style.transform = 'scale(1)'}
    >
      <div style={{ fontSize: 32, marginBottom: 8 }}>{icon}</div>
      <div style={{ fontWeight: 700, fontSize: 17, color: '#222', marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 13, color: '#666', lineHeight: 1.5 }}>{desc}</div>
    </button>
  );
}

export default App;

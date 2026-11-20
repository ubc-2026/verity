/* Verity front page: the market pop-up for the constellation dots, built with Meta's Astryx design system.
   Loaded on the first dot click. Exposes window.VerityDotDialog.open(market).
   All values come from the public Gemini Exchange API response the front page already fetched. */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Theme, defineTheme } from '@astryxdesign/core/theme';
// Same module instance as the theme barrel's Theme.js. Marking the tree as nested stops Theme from
// writing data-theme / data-astryx-theme onto <html>, so Astryx styles stay inside this pop-up.
import { ThemeNestingContext } from './node_modules/@astryxdesign/core/dist/theme/Theme.js';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Text } from '@astryxdesign/core/Text';
import { Heading } from '@astryxdesign/core/Heading';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Divider } from '@astryxdesign/core/Divider';
import { StatusDot } from '@astryxdesign/core/StatusDot';

const verityTheme = defineTheme({
  name: 'verity',
  tokens: {
    '--color-accent': ['#2E5CFF', '#2E5CFF'],
    '--color-text-accent': ['#2E5CFF', '#7C9BFF'],
    '--color-background-surface': ['#FFFFFF', '#10151E'],
    '--color-background-card': ['#FFFFFF', '#161D29'],
    '--color-background-body': ['#FFFFFF', '#090C10'],
    '--color-border': ['#D5DBE5', '#2A3550'],
    '--font-family-body': '"Space Grotesk", ui-sans-serif, system-ui, sans-serif',
    '--font-family-heading': '"Space Grotesk", ui-sans-serif, system-ui, sans-serif',
    '--font-family-code': '"JetBrains Mono", ui-monospace, monospace',
  },
});

const cents = (v) => (v == null || isNaN(v) ? '—' : (v * 100).toFixed(v < 0.1 || v > 0.9 ? 1 : 0) + '¢');
const usd = (v) => { v = +v || 0; return v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? '$' + (v / 1e3).toFixed(1) + 'k' : '$' + Math.round(v); };
const when = (iso) => { const t = Date.parse(iso || ''); if (!t) return '—'; return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const until = (iso) => { const ms = Date.parse(iso || '') - Date.now(); if (!(ms > 0)) return 'closing'; const h = ms / 36e5; return h < 1 ? Math.max(1, Math.round(ms / 6e4)) + ' min' : h < 48 ? Math.round(h) + ' h' : Math.round(h / 24) + ' days'; };

function Stat({ label, value, note }) {
  return (
    <VStack gap={1}>
      <Text type="supporting" color="secondary">{label}</Text>
      <Text type="large" weight="semibold" hasTabularNumbers>{value}</Text>
      {note ? <Text type="supporting" color="secondary">{note}</Text> : null}
    </VStack>
  );
}

function DotDialog({ market, onClose, onOpenTerminal }) {
  const m = market;
  const isOpen = !!m;
  if (!m) return <Dialog isOpen={false} onOpenChange={onClose}><div /></Dialog>;
  const spread = m.bid != null && m.ask != null ? Math.round((m.ask - m.bid) * 100) + '¢ spread' : 'no two-sided quote';
  const others = m.siblings || 0;
  return (
    <Dialog isOpen={isOpen} onOpenChange={(o) => { if (!o) onClose(); }} width={480} purpose="info">
      <DialogHeader title={m.title} subtitle={m.outcome} onOpenChange={(o) => { if (!o) onClose(); }} hasDivider />
      <VStack gap={5} style={{ padding: '20px 24px 24px' }}>
        <HStack gap={2} vAlign="center" style={{ flexWrap: 'wrap' }}>
          <StatusDot variant="success" label="Live from Gemini Exchange" isPulsing />
          <Text type="supporting" color="secondary">Live from Gemini Exchange</Text>
          {m.category ? <Badge variant="info" label={m.category} /> : null}
        </HStack>
        <HStack gap={6} vAlign="end" style={{ flexWrap: 'wrap' }}>
          <VStack gap={1}>
            <Text type="supporting" color="secondary">Market-implied probability</Text>
            <Heading level={2} type="display-2" color="accent" hasTabularNumbers>{cents(m.price)}</Heading>
          </VStack>
          <Text type="supporting" color="secondary" style={{ maxWidth: 220 }}>
            The crowd’s price for this outcome. It is not Verity’s resolution-risk rating, which the terminal scores from the rules.
          </Text>
        </HStack>
        <Divider />
        <HStack gap={6} style={{ flexWrap: 'wrap' }}>
          <Stat label="Bid / ask" value={cents(m.bid) + ' / ' + cents(m.ask)} note={spread} />
          <Stat label="Traded" value={usd(m.volume)} note={m.volume24h != null ? usd(m.volume24h) + ' in 24 h' : null} />
          <Stat label="Closes" value={until(m.expiry)} note={when(m.expiry)} />
        </HStack>
        {others > 0 ? <Text type="supporting" color="secondary">This market has {others + 1} outcomes. Each one is its own dot, at its own price.</Text> : null}
        <Divider />
        <HStack gap={3} justify="end" style={{ flexWrap: 'wrap' }}>
          <Button variant="ghost" label="Close" onClick={onClose} />
          <Button variant="primary" label="Score it in the demo" onClick={() => onOpenTerminal(m)} />
        </HStack>
        <Text type="supporting" color="secondary">
          Source: <a href={'https://api.gemini.com/v1/prediction-markets/events/' + encodeURIComponent(m.ticker)} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>Gemini Exchange public API, {m.ticker}</a>
        </Text>
      </VStack>
    </Dialog>
  );
}

function App({ bus }) {
  const [market, setMarket] = useState(null);
  useEffect(() => { bus.open = setMarket; }, [bus]);
  const openTerminal = (m) => {
    setMarket(null);
    try { sessionStorage.setItem('verity.pick', JSON.stringify({ ticker: m.ticker, contract: m.contractId })); } catch (e) {}
    if (window.verityOpenDemo) window.verityOpenDemo();
    if (window.verityPickMarket) window.verityPickMarket();
  };
  return (
    <ThemeNestingContext value={true}>
      <Theme theme={verityTheme} mode="dark">
        <DotDialog market={market} onClose={() => setMarket(null)} onOpenTerminal={openTerminal} />
      </Theme>
    </ThemeNestingContext>
  );
}

const bus = { open: null, queued: null };
const host = document.createElement('div');
host.id = 'verity-astryx-root';
document.body.appendChild(host);
createRoot(host).render(<App bus={bus} />);
window.VerityDotDialog = {
  open(m) {
    if (bus.open) bus.open(m);
    else { const t = setInterval(() => { if (bus.open) { clearInterval(t); bus.open(m); } }, 20); }
  },
};

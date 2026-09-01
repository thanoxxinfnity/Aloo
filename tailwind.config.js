/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,jsx}',
    './components/**/*.{js,jsx}',
    './hooks/**/*.{js,jsx}',
    './services/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      zIndex: {
        25: '25', // interactive HUD layer: above the passive overlay, below the drawer
      },
      colors: {
        // Year-2100 HUD palette
        void: '#0b0f19',
        abyss: '#070a12',
        cyanGlow: '#38bdf8',
        violetGlow: '#818cf8',
        hazard: '#f472b6',
        ok: '#34d399',
      },
      fontFamily: {
        hud: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 18px rgba(56, 189, 248, 0.35)',
        glowViolet: '0 0 18px rgba(129, 140, 248, 0.35)',
      },
      animation: {
        'scan': 'scan 6s linear infinite',
        'pulse-slow': 'pulse 3.2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow': 'spin 24s linear infinite',
        'flicker': 'flicker 4s ease-in-out infinite',
      },
      keyframes: {
        scan: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
        flicker: {
          '0%, 100%': { opacity: '0.85' },
          '48%': { opacity: '0.6' },
          '50%': { opacity: '1' },
          '52%': { opacity: '0.7' },
        },
      },
    },
  },
  plugins: [],
};

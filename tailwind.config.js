/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Matrix Theme Colors
        'matrix': {
          'bg': '#000a00',
          'bg-primary': '#000000',
          'bg-secondary': '#0a0a0a',
          'bg-tertiary': '#111111',
          'bg-accent': '#001100',
          'card': '#0a0f0a',
          'border': '#1a2f1a',
          'primary': '#00ff00',
          'secondary': '#ffa500',
          'text-primary': '#00ff00',
          'text-secondary': '#00cc00',
          'text-tertiary': '#009900',
          'text-muted': '#666666',
          'border-primary': '#00ff00',
          'border-secondary': '#00aa00',
          'border-tertiary': '#003300',
          'success': '#00ff00',
          'error': '#ff0040',
          'warning': '#ffff00',
          'info': '#00ffff',
        }
      },
      fontFamily: {
        'mono': ['JetBrains Mono', 'Fira Code', 'Courier New', 'monospace'],
      },
      animation: {
        'matrix-rain': 'matrix-rain 8s linear infinite',
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
        'text-flicker': 'text-flicker 3s ease-in-out infinite',
        'data-stream': 'data-stream 1.5s ease-in-out infinite',
      },
      keyframes: {
        'matrix-rain': {
          '0%': { transform: 'translateY(-100vh)', opacity: '0' },
          '10%': { opacity: '1' },
          '90%': { opacity: '1' },
          '100%': { transform: 'translateY(100vh)', opacity: '0' },
        },
        'glow-pulse': {
          '0%, 100%': { 
            boxShadow: '0 0 10px #00ff00, 0 0 20px rgba(0, 255, 0, 0.4)',
            textShadow: '0 0 5px #00ff00',
          },
          '50%': { 
            boxShadow: '0 0 15px #00ff00, 0 0 30px rgba(0, 255, 0, 0.5)',
            textShadow: '0 0 10px #00ff00, 0 0 20px #00ff00',
          },
        },
        'text-flicker': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.8' },
          '75%': { opacity: '0.9' },
        },
        'data-stream': {
          '0%': { transform: 'translateX(-100%)', opacity: '0' },
          '50%': { opacity: '1' },
          '100%': { transform: 'translateX(100%)', opacity: '0' },
        },
      },
      boxShadow: {
        'glow-subtle': '0 0 5px #00ff00, 0 0 10px rgba(0, 255, 0, 0.3)',
        'glow-normal': '0 0 10px #00ff00, 0 0 20px rgba(0, 255, 0, 0.4)',
        'glow-strong': '0 0 15px #00ff00, 0 0 30px rgba(0, 255, 0, 0.5)',
        'glow-error': '0 0 10px #ff0040, 0 0 20px rgba(255, 0, 64, 0.4)',
      },
    },
  },
  plugins: [],
}

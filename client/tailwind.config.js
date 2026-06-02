/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    './office/**/*.{js,jsx,html}',
    './extension/**/*.{js,jsx,html}'
  ],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        admin: {
          50: '#f8f9ff',
          100: '#f0f2ff',
          accent: '#4f46e5',
          'accent-hover': '#4338ca',
          surface: '#ffffff',
          'surface-dark': '#1f2937',
          border: '#e5e7eb',
          'border-dark': '#374151',
          muted: '#6b7280',
          'muted-dark': '#9ca3af'
        },
        indigo: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81'
        }
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif'
        ],
        mono: [
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'Liberation Mono',
          'Courier New',
          'monospace'
        ]
      }
    }
  },
  plugins: [require('@tailwindcss/typography')]
};

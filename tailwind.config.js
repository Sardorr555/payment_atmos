/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        syne: ['Syne', 'sans-serif'],
        sans: ['DM Sans', 'sans-serif'],
      },
      colors: {
        navy: {
          DEFAULT: '#0A0F1E',
          900: '#060913',
          800: '#0A0F1E',
          700: '#111827',
        },
        electric: {
          DEFAULT: '#2563EB',
          hover: '#1D4ED8',
        }
      }
    },
  },
  plugins: [],
}

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: [
    "./index.html",
    "./partials/**/*.html",
    "./src/**/*.js",
    "./public/js/**/*.js",
  ],
  theme: {
    extend: {
      colors: {
        gray: {
          850: "#172033",
        },
      },
    },
  },
  plugins: [],
};

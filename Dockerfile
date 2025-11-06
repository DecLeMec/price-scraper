# Playwright image has Chromium + all required system deps preinstalled
FROM mcr.microsoft.com/playwright:v1.46.0-jammy

# Create app dir
WORKDIR /app

# Copy package files and install deps
COPY package.json package-lock.json* ./
RUN npm install

# Copy the rest of your code
COPY . .

# Render provides PORT; your server already reads process.env.PORT
ENV NODE_ENV=production

# Start the server
CMD ["npm", "start"]

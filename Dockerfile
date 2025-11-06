FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
ENV NODE_ENV=production
CMD ["npm", "start"]

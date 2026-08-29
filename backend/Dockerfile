FROM node:24-alpine

# Patch the Alpine image to ensure all packages are up to date
RUN apk update && apk upgrade --no-cache

# Set the working directory inside the container
WORKDIR /app

# Copy dependency files first (this caches the npm install step)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your backend code
COPY . .

# Expose the WebSocket port
EXPOSE 3001

# Command to start the server (assumes you have a "start" script in package.json)
CMD ["npm", "start"]
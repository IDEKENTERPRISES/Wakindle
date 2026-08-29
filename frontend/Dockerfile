# Stage 1: Build the Vite app
FROM node:24-alpine AS builder

# Patch OS vulnerabilities in the builder
RUN apk update && apk upgrade --no-cache

WORKDIR /app

# Copy dependencies first for Docker caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the frontend code and build it
COPY . .
RUN npm run build 

# Stage 2: Serve the static files with Nginx
FROM nginx:alpine

# Patch OS vulnerabilities in the final Nginx image
RUN apk update && apk upgrade --no-cache

# Copy the built static files from Stage 1 into Nginx
COPY --from=builder /app/dist /usr/share/nginx/html

# Expose the web server port
EXPOSE 80

# Run Nginx in the foreground
CMD ["nginx", "-g", "daemon off;"]
# Use Node.js LTS version as the base image
FROM node:18-slim

# Set working directory
WORKDIR /app

# Copy package files to install dependencies first
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application files
COPY . .

# Expose port 8080 and set the environment variable
ENV PORT=8080

# Start the application
CMD ["npm", "start"]
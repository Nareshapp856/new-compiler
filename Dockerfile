# Base image for Node.js
FROM node:18-slim

# Install necessary compilers and interpreters
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    openjdk-17-jdk \
    mono-complete \
    python3 \
    python3-pip \
    && apt-get clean

# Set working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json for dependency installation
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the application code
COPY . .

# Expose the application port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]

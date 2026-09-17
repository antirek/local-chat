FROM node:20-alpine AS build
WORKDIR /server
COPY apps/server/package.json ./
RUN npm install
COPY apps/server/ ./
COPY vendor/chat3_user.proto /vendor/chat3_user.proto
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV CHAT3_PROTO_PATH=/app/vendor/chat3_user.proto
COPY apps/server/package.json ./
RUN npm install --omit=dev
COPY --from=build /server/dist ./dist
COPY --from=build /vendor/chat3_user.proto ./vendor/chat3_user.proto
EXPOSE 4000
CMD ["node", "dist/index.js"]

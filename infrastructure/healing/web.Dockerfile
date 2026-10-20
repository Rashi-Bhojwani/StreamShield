FROM nginx:1.30.6-alpine
COPY --chmod=755 apps/web/dist /usr/share/nginx/html

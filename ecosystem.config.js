module.exports = {
  apps: [
    {
      name: "backend_smart_eat_staging",
      script: "index.js", // ou app.js / server.js selon ton point d'entrée
      cwd: "./",
      watch: false,
      autorestart: true,
      max_memory_restart: "2G",
      env: {
        NODE_ENV: "local",
      },
      env_staging: {
        NODE_ENV: "staging",
      },
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};

/**
 * PM2 进程管理配置
 *
 * 使用：
 *   pm2 start ecosystem.config.cjs                 # 生产
 *   pm2 start ecosystem.config.cjs --env dev       # 开发
 *   pm2 reload ecosystem.config.cjs                 # 0 停机热重载
 *   pm2 logs mahjong-records                        # 查日志
 *   pm2 monit                                       # 实时监控
 */
module.exports = {
  apps: [
    {
      name: 'mahjong-records',
      script: './dist/index.js',
      instances: 1,            // 单实例即可（SQLite 写并发受限，后续可换 PG 后再开 cluster）
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3456
      },
      env_dev: {
        NODE_ENV: 'development',
        PORT: 3456
      },
      // 日志
      out_file: './data/pm2-out.log',
      error_file: './data/pm2-error.log',
      log_file: './data/pm2-combined.log',
      time: true,
      // 优雅退出
      kill_timeout: 5000,
      listen_timeout: 10000,
      // 部署钩子（pm2 deploy 时使用）
      post_deploy: 'npm install && npm run build'
    }
  ],

  // 部署配置（pm2 deploy production）
  // 实际用时填你的服务器 ssh 配置
  deploy: {
    production: {
      user: 'deploy',
      host: ['your-server-ip'],
      ref: 'origin/main',
      repo: 'git@github.com:your-name/mahjong-miniprogram.git',
      path: '/home/deploy/mahjong-miniprogram/server',
      'pre-deploy': 'git pull',
      'post-deploy': 'npm install && npm run build && pm2 reload ecosystem.config.cjs',
      env: {
        NODE_ENV: 'production'
      }
    }
  }
};
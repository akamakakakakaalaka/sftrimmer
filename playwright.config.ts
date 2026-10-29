import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'tests/browser',timeout:90000,workers:1,use:{baseURL:'http://127.0.0.1:5173',viewport:{width:390,height:844},hasTouch:true,launchOptions:{args:['--autoplay-policy=no-user-gesture-required']}},webServer:{command:'npm run dev -- --port 5173',url:'http://127.0.0.1:5173',reuseExistingServer:true,timeout:30000}});

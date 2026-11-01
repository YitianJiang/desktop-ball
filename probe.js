const fs=require('fs');const e=require('electron');fs.writeFileSync('C:/tmp/probe.txt','type='+process.type+' typeofE='+typeof e+' hasIpcMain='+!!e.ipcMain+'
');

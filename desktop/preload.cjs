const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  control: action => ipcRenderer.invoke('window-control', action),
  chooseWorkspace: () => ipcRenderer.invoke('choose-workspace'),
  saveSettings: values => ipcRenderer.invoke('save-settings', values),
  capturePreview: rect => ipcRenderer.invoke('capture-preview', rect)
});

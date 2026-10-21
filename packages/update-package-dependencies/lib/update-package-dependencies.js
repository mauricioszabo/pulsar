const electron = require('electron');
const UpdatePackageDependenciesStatusView = require('./update-package-dependencies-status-view');

module.exports = {
  activate() {
    this.subscription = atom.commands.add(
      'atom-workspace',
      'update-package-dependencies:update',
      () => this.update()
    );
  },

  deactivate() {
    this.subscription.dispose();
    if (this.updatePackageDependenciesStatusView) {
      this.updatePackageDependenciesStatusView.detach();
      this.updatePackageDependenciesStatusView = null;
    }
  },

  consumeStatusBar(statusBar) {
    this.updatePackageDependenciesStatusView = new UpdatePackageDependenciesStatusView(
      statusBar
    );
  },

  update() {
    if (this.running) return; // Do not allow concurrent installs.
    this.running = true;
    if (this.updatePackageDependenciesStatusView)
      this.updatePackageDependenciesStatusView.attach();

    const args = ['install', '--no-color'];
    const opts = { cwd: this.getActiveProjectPath() };

    this.runPackageManager({ args, opts }).then(
      ({ code, stderr }) => {
        this.running = false;
        if (this.updatePackageDependenciesStatusView)
          this.updatePackageDependenciesStatusView.detach();
        if (code === 0) {
          atom.notifications.addSuccess('Package dependencies updated');
        } else {
          atom.notifications.addError('Failed to update package dependencies', {
            detail: stderr,
            dismissable: true
          });
        }
      }
    );
  },

  // Exposed so tests can stub it.
  runPackageManager({ args, opts }) {
    return electron.ipcRenderer.invoke('package-manager:run', { args, opts });
  },

  getActiveProjectPath() {
    const activeItem = atom.workspace.getActivePaneItem();
    if (activeItem && typeof activeItem.getPath === 'function') {
      return atom.project.relativizePath(activeItem.getPath())[0];
    } else {
      return atom.project.getPaths()[0];
    }
  }
};

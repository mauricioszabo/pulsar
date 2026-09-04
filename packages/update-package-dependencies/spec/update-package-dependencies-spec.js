const os = require('os');
const path = require('path');
const updatePackageDependencies = require('../lib/update-package-dependencies');

describe('Update Package Dependencies', () => {
  let projectPath = null;

  beforeEach(() => {
    projectPath = __dirname;
    atom.project.setPaths([projectPath]);
  });

  describe('updating package dependencies', () => {
    let lastInvocation = null;
    let resolvePending = null;

    beforeEach(() => {
      lastInvocation = null;
      resolvePending = null;
      spyOn(updatePackageDependencies, 'runPackageManager').andCallFake(
        ({ args, opts }) => {
          lastInvocation = { args, opts };
          return new Promise(resolve => { resolvePending = resolve; });
        }
      );
    });

    afterEach(() => {
      if (resolvePending) resolvePending({ code: 0, stdout: '', stderr: '' });
    });

    it('invokes the in-process package manager with `install`', () => {
      updatePackageDependencies.update();
      expect(updatePackageDependencies.runPackageManager).toHaveBeenCalled();
      expect(lastInvocation.args).toEqual(['install', '--no-color']);
      expect(lastInvocation.opts.cwd).toEqual(projectPath);
    });

    it('only allows one run to be in flight at a time', () => {
      updatePackageDependencies.update();
      expect(updatePackageDependencies.runPackageManager.callCount).toBe(1);

      updatePackageDependencies.update();
      updatePackageDependencies.update();
      expect(updatePackageDependencies.runPackageManager.callCount).toBe(1);

      resolvePending({ code: 0, stdout: '', stderr: '' });
      waitsFor(() => !updatePackageDependencies.running);

      runs(() => {
        updatePackageDependencies.update();
        expect(updatePackageDependencies.runPackageManager.callCount).toBe(2);
      });
    });

    it('adds a status bar tile', async () => {
      const statusBar = await atom.packages.activatePackage('status-bar');

      const activationPromise = atom.packages.activatePackage(
        'update-package-dependencies'
      );
      atom.commands.dispatch(
        atom.views.getView(atom.workspace),
        'update-package-dependencies:update'
      );
      const { mainModule } = await activationPromise;

      mainModule.update();

      let tile = statusBar.mainModule.statusBar
        .getRightTiles()
        .find(tile => tile.item.matches('update-package-dependencies-status'));
      expect(
        tile.item.classList.contains('update-package-dependencies-status')
      ).toBe(true);
      expect(tile.item.firstChild.classList.contains('loading')).toBe(true);

      resolvePending({ code: 0, stdout: '', stderr: '' });
      await Promise.resolve();

      tile = statusBar.mainModule.statusBar
        .getRightTiles()
        .find(tile => tile.item.matches('update-package-dependencies-status'));
      expect(tile).toBeUndefined();
    });

    describe('when there are multiple project paths', () => {
      beforeEach(() => atom.project.setPaths([os.tmpdir(), projectPath]));

      it('uses the currently active one', async () => {
        await atom.workspace.open(path.join(projectPath, 'package.json'));

        updatePackageDependencies.update();
        expect(lastInvocation.opts.cwd).toEqual(projectPath);
      });
    });

    describe('when the update succeeds', () => {
      let notification = null;
      beforeEach(() => {
        updatePackageDependencies.update();
        resolvePending({ code: 0, stdout: '', stderr: '' });
        waitsFor(() => atom.notifications.getNotifications().length > 0);
        runs(() => { notification = atom.notifications.getNotifications()[0]; });
      });

      it('shows a success notification message', () => {
        expect(notification.getType()).toEqual('success');
        expect(notification.getMessage()).toEqual('Package dependencies updated');
      });
    });

    describe('when the update fails', () => {
      let notification = null;
      beforeEach(() => {
        updatePackageDependencies.update();
        resolvePending({ code: 127, stdout: '', stderr: 'oh bother' });
        waitsFor(() => atom.notifications.getNotifications().length > 0);
        runs(() => { notification = atom.notifications.getNotifications()[0]; });
      });

      it('shows a failure notification', () => {
        expect(notification.getType()).toEqual('error');
        expect(notification.getMessage()).toEqual('Failed to update package dependencies');
        expect(notification.getDetail()).toEqual('oh bother');
        expect(notification.isDismissable()).toBe(true);
      });
    });
  });

  describe('the `update-package-dependencies:update` command', () => {
    beforeEach(() => spyOn(updatePackageDependencies, 'update'));

    it('activates the package and updates package dependencies', async () => {
      const activationPromise = atom.packages.activatePackage(
        'update-package-dependencies'
      );
      atom.commands.dispatch(
        atom.views.getView(atom.workspace),
        'update-package-dependencies:update'
      );
      const { mainModule } = await activationPromise;
      expect(mainModule.update).toHaveBeenCalled();
    });
  });
});

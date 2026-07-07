// native modules
const path     = require('path');
const Debugger = require('homie-sdk/lib/utils/debugger');

const { EXTENSIONS, COMMON } = require('../errorCodes');
const { npm }                = require('../../etc/config');
const {
    exec,
    exists,
    X,
    readfile
} = require('../utils');

const ExtensionsManager = require('../../ExtensionsManager');

class NPM extends ExtensionsManager {
    // eslint-disable-next-line constructor-super
    constructor({
        extensionTypes = [],
        installPath = '.',
        defaultSchemePath = '/etc/scheme.json',
        defaultIconPath = '/etc/icon.svg'
    }) {
        super();
        this.extensionTypes         = extensionTypes;
        this.installPath            = installPath;
        this.defaultSchemePath      = defaultSchemePath;
        this.defaultIconPath        = defaultIconPath;
        this.searchURL              = npm.searchURL;
        this.searchByPackageNameURL = npm.searchByPackageNameURL;
        this.packageURL             = npm.packageURL;
        this.cliCommandTimeout      = npm.cliCommandTimeout;
        this.extensions             = {};
        this.language               = 'JS';
        this.debug                  = new Debugger(process.env.DEBUG || '*');
    }

    init() {
        this.debug.initEvents();

        return Promise.all(this.extensionTypes.map(extType => {
            return exec('npm init --yes', {
                cwd     : path.join(this.installPath, extType),
                timeout : this.cliCommandTimeout
            });
        }));
    }

    getLanguage() {
        return this.language;
    }

    async searchExtensions(text, options) {
        const { keywords } = options;
        const lowerText = (text || '').toLowerCase();
        const results = [];
        const fsPromises = require('fs').promises;

        for (const type of this.extensionTypes) {
            const dirPath = path.join(this.installPath, type, 'node_modules');

            try {
                const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });

                for (const entry of entries) {
                    if (!entry.isDirectory()) continue;

                    const pkgNames = [];

                    if (entry.name.startsWith('@')) {
                        const scopedPath = path.join(dirPath, entry.name);
                        try {
                            const sub = await fsPromises.readdir(scopedPath, { withFileTypes: true });
                            for (const s of sub) {
                                if (s.isDirectory()) pkgNames.push(`${entry.name}/${s.name}`);
                            }
                        } catch (e) { /* ignore */ }
                    } else {
                        pkgNames.push(entry.name);
                    }

                    for (const pkgName of pkgNames) {
                        try {
                            const pkgPath = path.join(dirPath, pkgName, 'package.json');
                            const pkg = JSON.parse(await fsPromises.readFile(pkgPath, 'utf-8'));

                            if (!pkg.keywords || !pkg.keywords.includes(type)) continue;

                            const nameMatch = !lowerText || pkg.name.toLowerCase().includes(lowerText);
                            const kwMatch = !keywords || !keywords.length ||
                                keywords.every(kw => pkg.keywords.includes(kw));

                            if (nameMatch && kwMatch) {
                                results.push({
                                    package : {
                                        name        : pkg.name,
                                        version     : pkg.version,
                                        description : pkg.description || '',
                                        keywords    : pkg.keywords || [],
                                        links       : { npm : '' }
                                    }
                                });
                            }
                        } catch (e) { /* ignore */ }
                    }
                }
            } catch (e) { /* ignore if dir doesn't exist */ }
        }

        return results;
    }

    async getExtensionTypeByExtensionName(extensionName) {
        // return extension type from cache if exists
        if (this.extensions[extensionName] && this.extensions[extensionName].type) {
            return this.extensions[extensionName].type;
        }

        const extension = await this.searchExtensionByName(extensionName);

        if (!extension || !extension.keywords || !extension.keywords.length) {
            throw new X({
                code   : EXTENSIONS.WRONG_TYPE,
                fields : {}
            });
        }

        // determine the extension type by first satisfied keyword
        const extensionType = extension.keywords.find(keyword => this.extensionTypes.includes(keyword));
        if (!extensionType) {
            throw new X({
                code   : EXTENSIONS.WRONG_TYPE,
                fields : {}
            });
        }

        return extensionType;
    }

    async isExtensionInstalled(extensionName, type) {
        const extensionPath = await this.getExtensionPath(extensionName, type);
        const isInstalled = await exists(extensionPath);

        return isInstalled;
    }

    async searchExtensionByName(extensionName) {
        for (const type of this.extensionTypes) {
            const pkgPath = path.join(this.installPath, type, 'node_modules', extensionName, 'package.json');

            if (await exists(pkgPath)) {
                try {
                    return JSON.parse(await readfile(pkgPath, 'utf-8'));
                } catch (e) { /* ignore */ }
            }
        }

        return null;
    }

    async getExtensionInstallPath(extensionName, extensionType) {
        const isInstalled = await this.isExtensionInstalled(extensionName, extensionType);

        if (isInstalled) {
            const extension = this.extensions[extensionName];

            if (extension && extension.installPath) return extension.installPath;

            const extensionInstallPath = path.join(this.installPath, extensionType);

            return extensionInstallPath;
        }

        // if extension is not installed
        throw new X({
            code   : COMMON.NOT_FOUND,
            fields : {}
        });
    }

    async installExtension(extensionName, extensionType) {
        const extensionInstallPath = path.join(this.installPath, extensionType);
        try {
            await exec(`npm i --no-package-lock ${extensionName}`, {
                cwd     : extensionInstallPath,
                timeout : this.cliCommandTimeout
            });

            this.extensions[extensionName] = {
                installPath : extensionInstallPath,
                type        : extensionType,
                config      : await this.getExtensionConfigObj(extensionName, extensionType)
            };
        } catch (err) {
            this.debug.warning('NPM.installExtension', err);
            throw new X({
                code   : EXTENSIONS.INSTALL_ERROR,
                fields : {}
            });
        }
    }

    async updateExtension(extensionName, extensionType) {
        const extensionInstallPath = await this.getExtensionInstallPath(extensionName, extensionType);

        try {
            await exec(`npm i --no-package-lock ${extensionName}@latest`, {
                cwd     : extensionInstallPath,
                timeout : this.cliCommandTimeout
            });

            // update extension config in cache after package update
            this.extensions[extensionName].config = await this.getExtensionConfigObj(extensionName, extensionType);
        } catch (err) {
            this.debug.warning('NPM.updateExtension', err);
            throw new X({
                code   : EXTENSIONS.UPDATE_ERROR,
                fields : {}
            });
        }
    }

    async uninstallExtension(extensionName, extensionType) {
        const extensionInstallPath = await this.getExtensionInstallPath(extensionName, extensionType);

        try {
            await exec(`npm uninstall --no-package-lock ${extensionName}`, {
                cwd     : extensionInstallPath,
                timeout : this.cliCommandTimeout
            });

            delete this.extensions[extensionName];
        } catch (err) {
            this.debug.warning('NPM.uninstallExtension', err);
            throw new X({
                code   : EXTENSIONS.UNINSTALL_ERROR,
                fields : {}
            });
        }
    }

    async hasAvailableUpdate() {
        // Fully local — no remote registry, updates are managed manually
        return false;
    }

    /**
     * Returns URI encoded extension name
     */
    prepareExtensionName(extensionName) {
        return encodeURIComponent(extensionName);
    }

    getExtensionInfoURL(extensionName) {
        // homie entity requires a non-empty link; use a local placeholder
        return `https://github.com/search?q=${this.prepareExtensionName(extensionName)}`;
    }

    async getExtensionConfigObj(extensionName, extensionType = '') {
        const packageDirPath = await this.getExtensionPath(extensionName, extensionType);

        if (await exists(packageDirPath)) {
            const configFilePath = path.join(packageDirPath, 'package.json');
            const configFile = await readfile(configFilePath, 'utf-8');

            return JSON.parse(configFile);
        }

        throw new X({
            code   : COMMON.NOT_FOUND,
            fields : {}
        });
    }

    async getExtensionScheme(extensionName, extensionType) {
        const packageDirPath = await this.getExtensionPath(extensionName, extensionType);
        const packageObj = await this.getExtensionConfigObj(extensionName, extensionType);

        const schemePath = packageObj.schemePath || this.defaultSchemePath;

        const absoluteSchemePath = path.join(
            packageDirPath,
            schemePath
        );

        if (await exists(absoluteSchemePath)) {
            const schemeFile = await readfile(absoluteSchemePath, 'utf-8');

            return JSON.parse(schemeFile);
        }

        return [];
    }

    async getExtensionIconPath(extensionName, extensionType) {
        const packageObj = this.extensions[extensionName] ?
            this.extensions[extensionName].config :
            await this.getExtensionConfigObj(extensionName, extensionType);

        const iconPath = packageObj.iconPath || this.defaultIconPath;

        const absoluteIconPath = path.join(
            await this.getExtensionInstallPath(extensionName, extensionType),
            'node_modules',
            extensionName,
            iconPath
        );

        return absoluteIconPath;
    }

    async getInstalledExtensions() {
        const packageConfigObjs = [];
        const packageNames = [];
        const fsPromises = require('fs').promises;

        try {
            for (const type of this.extensionTypes) {
                const dirPath = path.join(this.installPath, type, 'node_modules');
                // if node_modules dir is not exists then there are not installed modules
                // eslint-disable-next-line no-sync
                if (!(await exists(dirPath))) continue;

                const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });

                for (const entry of entries) {
                    if (!entry.isDirectory()) continue;

                    if (entry.name.startsWith('@')) {
                        const scopedPath = path.join(dirPath, entry.name);
                        try {
                            const scopedEntries = await fsPromises.readdir(scopedPath, { withFileTypes: true });
                            for (const scopedEntry of scopedEntries) {
                                if (scopedEntry.isDirectory()) {
                                    packageNames.push(`${entry.name}/${scopedEntry.name}`);
                                }
                            }
                        } catch (e) { /* ignore */ }
                        continue;
                    }

                    packageNames.push(entry.name);
                }

                for (const packageName of packageNames) {
                    try {
                        const packageConfigObj = await this.getExtensionConfigObj(packageName);
                        // if module is a 2smart extension and not an another dependency
                        if (packageConfigObj.keywords.includes(type)) {
                            this.extensions[packageName] = {
                                installPath : path.join(this.installPath, type),
                                type,
                                config      : packageConfigObj
                            };
                            packageConfigObjs.push(packageConfigObj);
                        }
                    } catch (err) {
                        // ignore WRONG_TYPE errors because packageNames array includes package names that are not
                        // related to 2smart project(dependencies of 2smart packages)
                        if (err.code !== EXTENSIONS.WRONG_TYPE) {
                            this.debug.warning(`ExtensionsService.getInstalledExtensions.${packageName}`, err);
                        }
                    }
                }
            }
        } catch (err) {
            this.debug.warning('ExtensionsService.getInstalledExtensions', err);
        }

        return packageConfigObjs;
    }

    async getExtensionPath(extensionName, type = '') {
        let extensionPath;

        if (this.extensions[extensionName] && this.extensions[extensionName].installPath) { // from cache
            extensionPath = path.join(this.extensions[extensionName].installPath, 'node_modules', extensionName);
        } else if (type) { // specified type
            extensionPath = path.join(this.installPath, type, 'node_modules', extensionName);
        } else {
            const extensionType = await this.getExtensionTypeByExtensionName(extensionName);
            extensionPath = path.join(this.installPath, extensionType, 'node_modules', extensionName);
        }

        return extensionPath;
    }
}

module.exports = NPM;

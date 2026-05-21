'use strict';

const TreeItemCollapsibleState = Object.freeze({ None: 0, Collapsed: 1, Expanded: 2 });
const TreeItemCheckboxState = Object.freeze({ Unchecked: 0, Checked: 1 });

class TreeItem {
  constructor(labelOrUri, collapsibleState) {
    const { Uri } = require('./uri');
    if (labelOrUri instanceof Uri) {
      this.resourceUri = labelOrUri;
      this.label = undefined;
    } else {
      this.label = labelOrUri;
      this.resourceUri = undefined;
    }
    this.collapsibleState = collapsibleState !== undefined ? collapsibleState : TreeItemCollapsibleState.None;
    this.id = undefined;
    this.iconPath = undefined;
    this.description = undefined;
    this.tooltip = undefined;
    this.command = undefined;
    this.contextValue = undefined;
    this.accessibilityInformation = undefined;
    this.checkboxState = undefined;
  }
}

module.exports = { TreeItemCollapsibleState, TreeItemCheckboxState, TreeItem };

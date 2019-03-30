import { Accounts } from 'meteor/accounts-base'
import { Permissions } from "/imports/api/permissions/permissions"


function initializeRoles() {
  const roles = Meteor.settings.roles;
  const admin = roles.admin || [];
  admin.map (email => {
    const user = Accounts.findUserByEmail(email);
    if (user) {
      if (!Permissions.isAdmin(user._id)) {
        console.info('Adding ' + user.emails[0].address + ' to admin role');
        Roles.addUsersToRoles(user._id, "admin", Roles.GLOBAL_GROUP);
      }
    } else {
      console.warn('user with email ' + email + ' not found')
    }
  });
}

if (Meteor.settings.roles) {
  initializeRoles();
}

import { Meteor } from "meteor/meteor";
import { check, Match } from "meteor/check";
import {
  Permissions,
  checkLoggedIn
} from "/imports/api/permissions/permissions";
import { Email } from "meteor/email";
import * as htmlToText from "html-to-text";

// Disable client insert/remove/update
Meteor.users.deny({
  insert() {
    return true;
  },
  remove() {
    return true;
  },
  update() {
    return true;
  }
});

Meteor.methods({
  "admin.findUsers"(page, filter, isOnline, isAway) {
    check(page, Number);
    check(filter, Match.Maybe(String));
    check(isOnline, Match.Maybe(Boolean));
    check(isAway, Match.Maybe(Boolean));

    if (!Permissions.isAdmin(Meteor.userId())) {
      throw new Meteor.Error(401, "not-authorized");
    }

    const perPage = 10;
    let skip = 0;
    if (page) {
      skip = (page - 1) * perPage;
    }

    if (!skip) {
      skip = 0;
    }
    let query = {};
    if (filter && filter.length > 0) {
      const emails = {
        $elemMatch: {
          address: { $regex: `.*${filter}.*`, $options: "i" }
        }
      };

      query = {
        $or: [
          { emails },
          {
            "profile.firstName": { $regex: `.*${filter}.*`, $options: "i" }
          },
          {
            "profile.lastName": { $regex: `.*${filter}.*`, $options: "i" }
          }
        ]
      };
    }
    if (isOnline) {
      if (!query.$or) query = { $or: [] };
      query.$or.push({ statusConnection: "online" });
    }
    if (isAway) {
      if (!query.$or) query = { $or: [] };
      query.$or.push({ statusConnection: "away" });
    }

    const count = Meteor.users.find(query).count();

    const data = Meteor.users
      .find(query, {
        fields: {
          profile: 1,
          status: 1,
          statusDefault: 1,
          statusConnection: 1,
          emails: 1,
          roles: 1
        },
        skip,
        limit: perPage,
        sort: {
          _id: 1
        }
      })
      .fetch();

    data.forEach((user) => {
      user.features = {
        emailVerified: user.emails[0].verified,
        isActive: Permissions.isActive(user),
        isAdmin: Permissions.isAdmin(user)
      };
    });

    return {
      rowsPerPage: perPage,
      totalItems: count,
      data
    };
  },

  "admin.updateUser"(user) {
    check(user, Object);

    if (!Meteor.userId()) {
      throw new Meteor.Error("not-authorized");
    }

    const { _id } = user;
    Meteor.users.update(
      {
        _id
      },
      {
        $set: {
          profile: user.profile,
          emails: user.emails
        }
      }
    );

    const features = user.features || {};
    if (user._id !== Meteor.userId()) {
      if (features.isActive && !Permissions.isActive(user)) {
        Meteor.call("admin.activateUser", user._id);
      } else if (!features.isActive && Permissions.isActive(user)) {
        Meteor.call("admin.deactivateUser", user._id);
      }
      if (features.emailVerified && !user.emails[0].verified) {
        Meteor.call("admin.confirmEmail", user._id);
      } else if (!features.emailVerified && user.emails[0].verified) {
        Meteor.call("admin.unconfirmEmail", user._id);
      }
      if (features.isAdmin && !Permissions.isAdmin(user)) {
        Permissions.setAdmin(user._id);
      } else if (!features.isAdmin && Permissions.isAdmin(user)) {
        Permissions.removeAdmin(user._id);
        Meteor.users.update(user._id, {
          $set: {
            "services.resume.loginTokens": []
          }
        });
      }
    }
  },

  "admin.deactivateUser"(userId) {
    check(userId, String);
    if (!Permissions.isAdmin(Meteor.userId())) {
      throw new Meteor.Error(401, "not-authorized");
    }
    Permissions.setInactive(userId);
  },

  "admin.activateUser"(userId) {
    check(userId, String);
    if (!Permissions.isAdmin(Meteor.userId())) {
      throw new Meteor.Error(401, "not-authorized");
    }
    Permissions.setActive(userId);
  },

  "admin.removeUser"(userId) {
    check(userId, String);
    if (userId === Meteor.userId()) {
      throw new Meteor.Error(401, "not-authorized");
    }
    if (!Permissions.isAdmin(Meteor.userId())) {
      throw new Meteor.Error(401, "not-authorized");
    }
    Meteor.users.update(userId, {
      $set: {
        "services.resume.loginTokens": []
      }
    });
    Meteor.users.remove(userId);
  },

  "admin.confirmEmail"(userId) {
    check(userId, String);
    if (!Permissions.isAdmin(Meteor.userId())) {
      throw new Meteor.Error(401, "not-authorized");
    }

    Meteor.users.update(
      { _id: userId },
      {
        $set: {
          "services.email.verificationTokens": [],
          "emails.0.verified": true
        }
      }
    );
  },

  "admin.unconfirmEmail"(userId) {
    check(userId, String);
    if (!Permissions.isAdmin(Meteor.userId())) {
      throw new Meteor.Error(401, "not-authorized");
    }

    Meteor.users.update(
      { _id: userId },
      {
        $set: {
          "emails.0.verified": false
        }
      }
    );
  },

  "admin.addUser"(user) {
    check(user, Object);
    if (!Permissions.isAdmin(Meteor.userId())) {
      throw new Meteor.Error(401, "not-authorized");
    }

    const existingUser = Meteor.users.findOne({
      emails: {
        $elemMatch: {
          address: { $regex: user.email, $options: "i" }
        }
      }
    });
    if (existingUser) {
      throw new Meteor.Error(401, "email-exists");
    }

    const userData = {
      createdAt: new Date(),
      email: user.email,
      profile: user.profile
    };
    const userId = Accounts.createUser(userData);
    if (user.isConfirmed) {
      Meteor.call("admin.confirmEmail", userId);
    } else {
      Meteor.call("admin.unconfirmEmail", userId);
    }
    if (user.isActive) {
      Meteor.call("admin.activateUser", userId);
    } else {
      Meteor.call("admin.deactivateUser", userId);
    }
    return userId;
  },

  "users.create"(userData) {
    check(userData, Object);
    if (Meteor.settings.disableAccountCreation) {
      throw new Meteor.Error("not-authorized");
    }
    const userId = Accounts.createUser(userData);
    Accounts.sendVerificationEmail(userId);
  },

  "users.getEmailPreferences"() {
    if (!Meteor.userId()) {
      throw new Meteor.Error("not-authorized");
    }
    const user = Meteor.users.findOne({ _id: Meteor.userId() });
    user.emailSettings = user.emailSettings || {};
    user.emailSettings.tasks = user.emailSettings.tasks || {
      assignTo: true,
      update: true
    };
    user.emailSettings.digests = user.emailSettings.digests || {
      daily: true
    };
    return user;
  },

  "users.updateEmailPreferences"(settings) {
    check(settings, Object);
    if (!Meteor.userId()) {
      throw new Meteor.Error("not-authorized");
    }
    Meteor.users.update(
      {
        _id: Meteor.userId()
      },
      {
        $set: {
          emailSettings: settings
        }
      }
    );
  },

  "users.findUsers"(page, filter) {
    check(page, Number);
    check(filter, Match.Maybe(String));
    checkLoggedIn();

    let restriction = "all";
    if (
      Meteor.settings
      && Meteor.settings.users
      && Meteor.settings.users.search
    ) {
      restriction = Meteor.settings.users.search;
    }

    if (restriction === "admin") {
      if (!Permissions.isAdmin(Meteor.userId())) {
        throw new Meteor.Error(401, "not-authorized");
      }
    }

    const perPage = 5;
    let skip = 0;
    if (page) {
      skip = (page - 1) * perPage;
    }

    if (!skip) {
      skip = 0;
    }
    let query = {};
    if (filter && filter.length > 0) {
      const emails = {
        $elemMatch: {
          address: { $regex: `.*${filter}.*`, $options: "i" }
        }
      };

      query = {
        $or: [
          { emails },
          {
            "profile.firstName": { $regex: `.*${filter}.*`, $options: "i" }
          },
          {
            "profile.lastName": { $regex: `.*${filter}.*`, $options: "i" }
          }
        ]
      };
    }

    const count = Meteor.users.find(query).count();

    const data = Meteor.users
      .find(query, {
        fields: {
          profile: 1,
          emails: 1
        },
        skip,
        limit: perPage,
        sort: {
          _id: 1
        }
      })
      .fetch();

    return {
      rowsPerPage: perPage,
      totalItems: count,
      data
    };
  },

  "users.invite"(email) {
    check(email, String);
    checkLoggedIn();

    let restriction = "all";
    if (
      Meteor.settings
      && Meteor.settings.users
      && Meteor.settings.users.invite
    ) {
      restriction = Meteor.settings.users.invite;
    }

    if (restriction === "admin") {
      if (!Permissions.isAdmin(Meteor.userId())) {
        throw new Meteor.Error(401, "not-authorized");
      }
    }

    const userData = {
      profile: {
        firstName: "",
        lastName: ""
      },
      email
    };

    const existingUser = Meteor.users.findOne({
      emails: {
        $elemMatch: {
          address: { $regex: userData.email, $options: "i" }
        }
      }
    });
    if (existingUser) {
      throw new Meteor.Error(401, "email-exists");
    }

    const userId = Accounts.createUser({
      createdAt: new Date(),
      email: userData.email,
      profile: userData.profile
    });
    Meteor.users.update(
      { _id: userId },
      {
        $set: {
          "services.email.verificationTokens": [],
          "emails.0.verified": true
        }
      }
    );

    const user = Meteor.users.findOne({ _id: userId });
    Meteor.call("users.sendInvitation", user);
    return user;
  },

  "users.sendInvitation"(user) {
    check(user, Object);
    this.unblock();

    const emailData = {
      subject() {
        return "Invitation ?? collaborer sur L'atelier";
      },
      html() {
        const email = new MJML(Assets.absoluteFilePath("mjml/invitation.mjml"));
        email.helpers({
          url: Meteor.absoluteUrl(),
          emailSettingsUrl: Meteor.absoluteUrl("/settings/mail")
        });
        return email.compile();
      }
    };
    const html = emailData.html();
    const text = htmlToText.fromString(html, {
      tables: true
    });
    try {
      Email.send({
        from: Meteor.settings.email.from,
        to: user.emails[0].address,
        subject: emailData.subject(),
        text,
        html
      });
    } catch (error) {
      /* eslint no-console:off */
      console.error(error);
    }
  },

  "users.getProfile"() {
    if (!Meteor.userId()) {
      throw new Meteor.Error("not-authorized");
    }
    const options = {
      fields: {
        profile: 1,
        status: 1,
        statusDefault: 1,
        statusConnection: 1,
        emails: 1,
        roles: 1
      }
    };

    const user = Meteor.users.findOne({ _id: Meteor.userId() }, options);
    return user;
  }
});

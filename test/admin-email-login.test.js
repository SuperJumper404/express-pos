const assert = require("assert");
const Module = require("module");
const path = require("path");
const bcrypt = require("bcrypt");

const originalLoad = Module._load;
const controllerPath = path.join(__dirname, "..", "src", "controllers", "c_users.js");

const createResponse = () => ({
  statusCode: null,
  payload: null,
  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  },
  json(payload) {
    this.payload = payload;
    return this;
  },
});

const respond = (res, statusCode, message, data) =>
  res.status(statusCode).json({ message, data });

(async () => {
  const password = "admin-secret";
  const admin = {
    id: 42,
    shopid: 7,
    username: "Admin",
    email: "duplicate@example.test",
    password: await bcrypt.hash(password, 10),
    clearpass: password,
    phone: "",
    status: 1,
    access: 0,
  };
  const duplicateEmailAccount = {
    id: 43,
    shopid: 7,
    username: "Click and collect",
    email: "duplicate@example.test",
    password: await bcrypt.hash("other-secret", 10),
    phone: "",
    status: 1,
    access: 3,
  };
  const updates = [];

  Module._load = function load(request, parent, isMain) {
    if (parent && parent.filename === controllerPath) {
      if (request === "../modules/m_users") {
        return {
          mCheckEmail: async () => [],
          mFindUserByEmail: async () => [admin, duplicateEmailAccount],
          mFindUserByStaffLoginId: async () => [],
          mFindUserByIdAndShop: async () => [],
          mRegister: async () => ({}),
          mActivation: async () => [],
          mActivationUser: async () => ({}),
          mDeleteActivation: async () => ({}),
          mProfileMe: async () => [],
          mGetAllUser: async () => [],
          mDetailUser: async () => [],
          mSessionUser: async () => [admin],
          mDetailUserWithSecretFields: async () => [],
          mUpdateUser: async (data) => {
            updates.push(data);
            return {};
          },
          mDeleteUser: async () => ({}),
        };
      }
      if (request === "../helpers/response") {
        return {
          custom: (res, statusCode, message, data) => respond(res, statusCode, message, data),
          success: (res, message, meta, data) => respond(res, 200, message, data),
          failed: (res, message, error) => respond(res, 500, message, error),
        };
      }
      if (request === "../helpers/env") return { envJWTKEY: "test-key" };
      if (request === "../helpers/tableAccessToken") return {};
      if (request === "../helpers/tableAccessLoginData") return {};
      if (request === "../helpers/mailer") return {};
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const { loginWithStaffCredentials } = require(controllerPath);
  Module._load = originalLoad;

  const response = createResponse();
  await loginWithStaffCredentials(
    { body: { email: "duplicate@example.test", password } },
    response,
  );

  assert.equal(
    response.statusCode,
    200,
    "an active administrator must be able to sign in when a non-admin shares the email",
  );
  assert.equal(response.payload.data[0].id, admin.id);
  assert.equal(
    updates.length,
    1,
    "a current password hash must not trigger a legacy password migration",
  );
  console.log("admin email login tests passed");
})().catch((error) => {
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});

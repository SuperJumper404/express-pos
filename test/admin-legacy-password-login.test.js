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
  const password = "legacy-admin-secret";
  const admin = {
    id: 52,
    shopid: 7,
    username: "Admin",
    email: "legacy@example.test",
    password: await bcrypt.hash("previous-secret", 10),
    clearpass: password,
    phone: "",
    status: 1,
    access: 0,
  };
  const updates = [];

  Module._load = function load(request, parent, isMain) {
    if (parent && parent.filename === controllerPath) {
      if (request === "../modules/m_users") {
        return {
          mCheckEmail: async () => [],
          mFindUserByEmail: async () => [admin],
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
    { body: { email: "legacy@example.test", password } },
    response,
  );

  assert.equal(
    response.statusCode,
    200,
    "a legacy administrator must retain access with the existing password",
  );
  assert.equal(updates[0].clearpass, "");
  assert.equal(await bcrypt.compare(password, updates[0].password), true);
  console.log("admin legacy password login tests passed");
})().catch((error) => {
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});

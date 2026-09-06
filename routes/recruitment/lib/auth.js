import { SignJWT, jwtVerify } from "jose";
import prisma from "../../../prismaClient.js";

function getSecretKey() {
  return process.env.JWT_SECRET || "HACKCLUB_VIT_SECRET_SESSION_TOKEN_KEY_2026";
}

const getEncodedKey = () => new TextEncoder().encode(getSecretKey());

export async function signToken(payload) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getEncodedKey());
}

export async function verifyToken(token = "") {
  try {
    const { payload } = await jwtVerify(token, getEncodedKey(), {
      algorithms: ["HS256"],
    });
    return payload;
  } catch (error) {
    return null;
  }
}

export async function getSession(req) {
  if (!req) return null;
  let token = req.cookies?.session;
  if (!token && req.headers?.authorization) {
    const authHeader = req.headers.authorization;
    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7).trim();
    }
  }
  if (!token) return null;
  const payload = await verifyToken(token);
  if (!payload || !payload.id) return null;
  
  // Dev mock user support
  if (typeof payload.id === "string" && payload.id.startsWith("dev-mock-id")) {
    return {
      id: payload.id,
      email: payload.email || "dev@hackclubvit.local",
      role: payload.role || "ADMIN",
      departments: payload.departments || ["*"]
    };
  }
  
  let userId;
  try {
    userId = BigInt(payload.id);
  } catch (err) {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId }
  });
  
  if (!user || user.status !== "Active") return null;

  const assignment = await prisma.recruitmentRoleAssignment.findUnique({
    where: { user_id: userId }
  });

  return {
    id: user.id.toString(),
    email: user.email,
    role: assignment?.active ? assignment.role : (payload.role || "NONE"),
    departments: assignment?.active ? assignment.departments : (payload.departments || [])
  };
}

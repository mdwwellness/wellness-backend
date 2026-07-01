import express from "express";
import userAuth from "../middlewares/userAuth.ts";
import {
  createInvoice,
  generateInvoicePdf,
  getInvoice,
  getInvoices,
  updateInvoice,
} from "../controllers/invoiceController.ts";

const invoiceRouter = express.Router();

invoiceRouter.get("/", userAuth, getInvoices);
invoiceRouter.post("/", userAuth, createInvoice);
invoiceRouter.get("/:invoiceId", userAuth, getInvoice);
invoiceRouter.patch("/:invoiceId", userAuth, updateInvoice);
invoiceRouter.post("/:invoiceId/pdf", userAuth, generateInvoicePdf);

export default invoiceRouter;


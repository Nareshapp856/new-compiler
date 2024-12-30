const express = require("express");
const fs = require("fs/promises");
const { exec } = require("child_process");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");
const compression = require("compression");
const morgan = require("morgan");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cluster = require("cluster");
const os = require("os");
const winston = require("winston");
const { log } = require("console");

const numCPUs = os.cpus().length; // Number of CPU cores
const port = process.env.PORT || 3000; // Port for the app

// Set up winston for structured logging
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      // Customize the format with line breaks and proper alignment
      const lines = message.split(". ");
      return `${level}: ${lines[0]}.\n${lines[1]}.\n${JSON.stringify({ timestamp }, null, 2)}`;
    })
  ),
  transports: [
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});


if (cluster.isMaster) {
  logger.info(`Master process running. Forking ${numCPUs} workers.`);

  // Fork workers based on available CPU cores
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker) => {
    logger.info(`Worker ${worker.process.pid} exited. Forking a new one.`);
    cluster.fork();
  });
} else {
  const app = express();

  // Middleware setup
  app.use(express.json());
  app.use(cors());
  app.use(compression());
  app.use(morgan("combined"));
  app.use(helmet());
  app.use(
    rateLimit({
      windowMs: 1 * 30 * 1000, // 30 seconds
      max: 1000, // Limit each IP to 500 requests per windowMs
      output: "Too many requests from this IP, please try again later.",
    })
  );

  // Utility to cleanup temporary files
  const cleanup = async (tempDir) => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (err) {
      // logger.error("Error during cleanup:", err);
      console.error("Error during cleanup:", err);
    }
  };

  // Function to prepare input for execution
  const prepareInputFile = async (tempDir, inputArray) => {
    if (!Array.isArray(inputArray)) {
      throw new Error("Input should be an array of strings.");
    }
    const inputFilePath = path.join(tempDir, "input.txt");
    const inputContent = inputArray.join("\n");
    await fs.writeFile(inputFilePath, inputContent);
    return inputFilePath;
  };

  // API endpoint for running the program
  app.post("/run-program", async (req, res) => {

    console.log("-----------------");
    console.log("Compile hit started");

    const { code, language, input } = req.body;

    if (!code || !language) {
      return res.status(400).json({
        responseCode: 203,
        output: "Code and language are required.",
        errorMessage: "Code and language are required.",
      });
    }

    if (code.length > 5000 || (input && input.length > 1000)) {
      return res.status(400).json({
        responseCode: 203,
        output: "Code or input is too large. Please limit their sizes.",
        errorMessage: "",
      });
    }

    const tempDir = path.join(__dirname, "temp", uuidv4());
    await fs.mkdir(tempDir, { recursive: true });

    const fileExtensions = {
      java: "java",
      python: "py",
      javascript: "js",
      c: "c",
      cpp: "cpp",
      csharp: "cs",
    };

    const fileExtension = fileExtensions[language.toLowerCase()];
    if (!fileExtension) {
      await cleanup(tempDir);
      return res.status(400).json({
        responseCode: 203,
        output: "Unsupported language.",
        errorMessage: "Unsupported language.",
      });
    }

    let fileName = `Program.${fileExtension}`;
    let filePath = path.join(tempDir, fileName);

    if (language.toLowerCase() === "java") {
      const classNameMatch = code.match(/class\s+([a-zA-Z_$][a-zA-Z\d_$]*)/);
      if (classNameMatch && classNameMatch[1]) {
        fileName = `${classNameMatch[1]}.java`;
        filePath = path.join(tempDir, fileName);
      } else {
        await cleanup(tempDir);
        return res.status(400).json({
          responseCode: 400,
          output: "Invalid Java code. Class name is missing.",
          errorMessage: "",
        });
      }
    }

    try {
      await fs.writeFile(filePath, code);

      let inputFilePath = null;
      if (input) {
        inputFilePath = await prepareInputFile(tempDir, input);
      }

      let executionCommand;
      switch (language.toLowerCase()) {
        case "java":
          executionCommand = `javac ${filePath} && java -cp ${tempDir} ${path.basename(fileName, ".java")}`;
          if (inputFilePath) {
            executionCommand = `javac ${filePath} && java -cp ${tempDir} ${path.basename(fileName, ".java")} < ${inputFilePath}`;
          }
          break;
        case "python":
          executionCommand = `python3 ${filePath}`;
          if (inputFilePath) {
            executionCommand = `python3 ${filePath} < ${inputFilePath}`;
          }
          break;
        case "javascript":
          executionCommand = `node ${filePath}`;
          if (inputFilePath) {
            executionCommand = `node ${filePath} < ${inputFilePath}`;
          }
          break;
        case "c":
          const cOutputFile = path.join(tempDir, "program");
          executionCommand = `gcc ${filePath} -o ${cOutputFile} && ${cOutputFile}`;
          if (inputFilePath) {
            executionCommand = `gcc ${filePath} -o ${cOutputFile} && ${cOutputFile} < ${inputFilePath}`;
          }
          break;
        case "cpp":
          const cppOutputFile = path.join(tempDir, "program");
          executionCommand = `g++ ${filePath} -o ${cppOutputFile} && ${cppOutputFile}`;
          if (inputFilePath) {
            executionCommand = `g++ ${filePath} -o ${cppOutputFile} && ${cppOutputFile} < ${inputFilePath}`;
          }
          break;
        case "csharp":
          const csharpOutputFile = path.join(tempDir, "Program.exe");
          executionCommand = `mcs ${filePath} -out:${csharpOutputFile} && mono ${csharpOutputFile}`;
          if (inputFilePath) {
            executionCommand = `mcs ${filePath} -out:${csharpOutputFile} && mono ${csharpOutputFile} < ${inputFilePath}`;
          }
          break;
      }

      exec(executionCommand, { timeout: 300000 }, async (error, stdout, stderr) => {
        await cleanup(tempDir);

        if (error) {
          if (error.killed) {
            logger.error('Execution timed out after 30 seconds for command');
            logger.error(executionCommand)
            console.error('Execution timed out after 30 seconds for command');
            console.error(executionCommand)
            return res.status(500).json({
              responseCode: 202,
              output: "Execution timed out after 30 seconds.",
              errorMessage: "",
            });
          }

          const isCompilationError = stderr.includes("error");
          logger.error('Error executing code');
          logger.error(stderr);
          console.error('Execution timed out after 30 seconds for command');
          console.error(executionCommand)
          return res.status(500).json({
            responseCode: 202,
            output: stderr.trim() || error.message,
            errorMessage: isCompilationError ? "Compilation error occurred." : "Runtime error occurred."
          });
        }

        logger.info('Code executed successfully');
        logger.info(stdout.trim());
        console.info('Code executed successfully');
        console.info(stdout.trim());
        res.status(200).json({
          responseCode:201,
          errorMessage: "",
          output: stdout.trim(),
        });
      });
    } catch (err) {
      await cleanup(tempDir);
      logger.error(`Internal server error: ${err.message}`);
      logger.error(err);
      console.error(`Internal server error: ${err.message}`);
      console.error(err);
      res.status(500).json({
        responseCode:202,
        output: err.message,
        errorMessage: "Internal server error occurred."
      });
    }
  });

  // Start server
  app.listen(port, "0.0.0.0", () => {
    logger.info(`Worker ${process.pid} is running on port ${port}`);
  });
}

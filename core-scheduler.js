// General scheduler logic and UI extracted from script.js
// All functions and variables are globally accessible

// --- Scheduler Variables ---
let schedules = [];
const daysMap = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
let scheduleCheckInterval;
let schedulerEnabled = true;
let editingScheduleId = null;
let draggedId = null;

// --- DOM References for Scheduler ---
const importDataArea = document.getElementById("importDataArea");
const loadImportedDataBtn = document.getElementById("loadImportedDataBtn");
const scheduleListTableBody = document.querySelector(
  "#schedule-list-table tbody"
);
const daysOfWeekCheckboxes = Array.from(
  document.querySelectorAll('#schedule-days-container input[type="checkbox"]')
);
const scheduleDaysContainerWrapper = document.getElementById(
  "schedule-days-container-wrapper"
);
const btnToggleScheduler = document.getElementById("btnToggleScheduler");
const addScheduleBtn = document.getElementById("addScheduleBtn");

// --- Scheduler Functions ---
function toggleDaysOfWeek() {
  const recurrenceType = document.getElementById("scheduleRecurrence").value;
  scheduleDaysContainerWrapper.style.display =
    recurrenceType === "days" ? "flex" : "none";
}

async function addSchedule() {
  const time = document.getElementById("scheduleTime").value;
  const source = document.getElementById("scheduleSource").value;
  const action = document.getElementById("scheduleAction").value;
  const recurrenceType = document.getElementById("scheduleRecurrence").value;
  const title = document.getElementById("scheduleTitle").value.trim();
  let days = [];
  let scheduledDay = null;

  if (!time || !source || !action) {
    console.warn("Please fill in all schedule fields.");
    return;
  }

  if (recurrenceType === "days") {
    days = daysOfWeekCheckboxes
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => parseInt(checkbox.value));
    if (days.length === 0) {
      console.warn(
        "Please select at least one day for 'Specific Days' recurrence."
      );
      return;
    }
  } else if (recurrenceType === "weekly") {
    scheduledDay = new Date().getDay();
  }

  if (editingScheduleId !== null) {
    const scheduleIndex = schedules.findIndex(
      (s) => s.id === editingScheduleId
    );
    if (scheduleIndex > -1) {
      schedules[scheduleIndex].time = time;
      schedules[scheduleIndex].source = source;
      schedules[scheduleIndex].action = action;
      schedules[scheduleIndex].recurrence = recurrenceType;
      schedules[scheduleIndex].days = days;
      schedules[scheduleIndex].scheduledDay = scheduledDay;
      schedules[scheduleIndex].title = title;
    }
    editingScheduleId = null;
  } else {
    const newSchedule = {
      id: Date.now(),
      time: time,
      source: source,
      action: action,
      recurrence: recurrenceType,
      days: days,
      scheduledDay: scheduledDay,
      lastTriggered: null,
      enabled: true,
      title: title,
    };
    schedules.push(newSchedule);
  }

  saveSchedules();
  renderSchedules();
  resetScheduleForm();
}

function editSchedule(id) {
  const schedule = schedules.find((s) => s.id === id);
  if (schedule) {
    document.getElementById("scheduleTime").value = schedule.time;
    document.getElementById("scheduleSource").value = schedule.source;
    document.getElementById("scheduleAction").value = schedule.action;
    document.getElementById("scheduleRecurrence").value = schedule.recurrence;
    document.getElementById("scheduleTitle").value = schedule.title;

    daysOfWeekCheckboxes.forEach((checkbox) => {
      checkbox.checked = schedule.days.includes(parseInt(checkbox.value));
    });
    toggleDaysOfWeek();

    editingScheduleId = id;
    document.getElementById("addScheduleBtn").textContent = "Update Schedule";
  }
}

function deleteSchedule(id) {
  schedules = schedules.filter((schedule) => schedule.id !== id);
  saveSchedules();
  renderSchedules();
}

function saveSchedules() {
  localStorage.setItem("obsSchedules", JSON.stringify(schedules));
}

function loadSchedules() {
  const storedSchedules = localStorage.getItem("obsSchedules");
  if (storedSchedules) {
    schedules = JSON.parse(storedSchedules);
    schedules.forEach((schedule) => {
      if (typeof schedule.enabled === "undefined") {
        schedule.enabled = true;
      }
      if (typeof schedule.title === "undefined") {
        schedule.title = "";
      }
      if (typeof schedule.lastTriggered === "undefined") {
        schedule.lastTriggered = null;
      }
      if (typeof schedule.id === "undefined") {
        schedule.id = Date.now() + Math.random();
      }
    });
  }
}

function formatTimeTo12Hr(timeString) {
  const [hours, minutes] = timeString.split(":").map(Number);
  const date = new Date();
  date.setHours(hours);
  date.setMinutes(minutes);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function renderSchedules() {
  scheduleListTableBody.innerHTML = "";
  schedules.forEach((schedule) => {
    const row = scheduleListTableBody.insertRow();
    row.id = schedule.id;
    row.draggable = true;

    row.addEventListener("dragstart", handleDragStart);
    row.addEventListener("dragover", handleDragOver);
    row.addEventListener("dragleave", handleDragLeave);
    row.addEventListener("drop", handleDrop);
    row.addEventListener("dragend", handleDragEnd);

    let recurrenceDisplay;
    if (schedule.recurrence === "days") {
      recurrenceDisplay = schedule.days
        .map((dayIdx) => daysMap[dayIdx])
        .join(", ");
    } else if (schedule.recurrence === "weekly") {
      recurrenceDisplay = `Weekly (${daysMap[schedule.scheduledDay]})`;
    } else {
      recurrenceDisplay =
        schedule.recurrence.charAt(0).toUpperCase() +
        schedule.recurrence.slice(1);
    }

    row.insertCell().textContent = formatTimeTo12Hr(schedule.time);
    row.insertCell().textContent = schedule.source;
    row.insertCell().textContent =
      schedule.action.charAt(0).toUpperCase() + schedule.action.slice(1);
    row.insertCell().textContent = recurrenceDisplay;
    row.insertCell().textContent = schedule.title || "";

    const statusCell = row.insertCell();
    const toggleBtn = document.createElement("button");
    toggleBtn.className =
      "schedule-toggle-btn " +
      (schedule.enabled ? "on-individual-schedule" : "off-individual-schedule");
    toggleBtn.textContent = schedule.enabled ? "Enabled" : "Disabled";
    toggleBtn.onclick = () => toggleIndividualSchedule(schedule.id);
    statusCell.appendChild(toggleBtn);

    const actionCell = row.insertCell();
    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.className = "edit-btn";
    editBtn.onclick = () => editSchedule(schedule.id);
    actionCell.appendChild(editBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.className = "delete-btn";
    deleteBtn.onclick = () => deleteSchedule(schedule.id);
    actionCell.appendChild(deleteBtn);
  });
}

function handleDragStart(e) {
  draggedId = parseInt(e.target.id);
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", draggedId);
  setTimeout(() => e.target.classList.add("dragging"), 0);
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";

  const targetRow = e.target.closest("tr");
  if (targetRow && targetRow.id !== draggedId) {
    Array.from(scheduleListTableBody.children).forEach((row) => {
      row.classList.remove("drag-over-top", "drag-over-bottom");
    });

    const targetRect = targetRow.getBoundingClientRect();
    const centerY = targetRect.top + targetRect.height / 2;

    if (e.clientY < centerY) {
      targetRow.classList.add("drag-over-top");
    } else {
      targetRow.classList.add("drag-over-bottom");
    }
  }
}

function handleDragLeave(e) {
  e.target.classList.remove("drag-over-top", "drag-over-bottom");
}

function handleDrop(e) {
  e.preventDefault();

  Array.from(scheduleListTableBody.children).forEach((row) => {
    row.classList.remove("drag-over-top", "drag-over-bottom");
  });

  const targetRow = e.target.closest("tr");
  if (!targetRow || targetRow.id === draggedId) {
    return;
  }

  const targetId = parseInt(targetRow.id);
  const draggedSchedule = schedules.find((s) => s.id === draggedId);
  const targetSchedule = schedules.find((s) => s.id === targetId);

  if (!draggedSchedule || !targetSchedule) return;

  const draggedIndex = schedules.indexOf(draggedSchedule);
  let targetIndex = schedules.indexOf(targetSchedule);

  const targetRect = targetRow.getBoundingClientRect();
  const centerY = targetRect.top + targetRect.height / 2;
  const dropPosition = e.clientY < centerY ? "before" : "after";

  schedules.splice(draggedIndex, 1);

  if (draggedIndex < targetIndex) {
    targetIndex--;
  }

  if (dropPosition === "after") {
    schedules.splice(targetIndex + 1, 0, draggedSchedule);
  } else {
    schedules.splice(targetIndex, 0, draggedSchedule);
  }

  saveSchedules();
  renderSchedules();
}

function handleDragEnd(e) {
  e.target.classList.remove("dragging");
  Array.from(scheduleListTableBody.children).forEach((row) => {
    row.classList.remove("drag-over-top", "drag-over-bottom");
  });
  draggedId = null;
}

function resetScheduleForm() {
  document.getElementById("scheduleTime").value = "";
  document.getElementById("scheduleSource").value = "Live Player";
  document.getElementById("scheduleAction").value = "show";
  document.getElementById("scheduleRecurrence").value = "daily";
  daysOfWeekCheckboxes.forEach((checkbox) => (checkbox.checked = false));
  toggleDaysOfWeek();
  document.getElementById("scheduleTitle").value = "";
  document.getElementById("addScheduleBtn").textContent = "Add Schedule";
  editingScheduleId = null;
}

function startScheduleChecker() {
  if (scheduleCheckInterval) clearInterval(scheduleCheckInterval);
  scheduleCheckInterval = setInterval(checkSchedules, 1000); // Check every 1 second for reliability
  // console.log("Scheduler started. Checking tasks every 1 second.");
}

function checkSchedules() {
  if (!schedulerEnabled || !socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  if (sourceState["Live Player"] === true) {
    // console.log("[Scheduler] Skipping all schedules because Live Player is active.");
    return;
  }

  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const currentDay = now.getDay();
  const currentDayTimeIdentifier = `${currentHour
    .toString()
    .padStart(2, "0")}:${currentMinute
      .toString()
      .padStart(2, "0")}-${currentDay}`;

  schedules.forEach((schedule) => {
    if (!schedule.enabled) {
      return;
    }

    const [scheduleHour, scheduleMinute] = schedule.time.split(":").map(Number);

    if (currentHour === scheduleHour && currentMinute === scheduleMinute) {
      if (schedule.lastTriggered === currentDayTimeIdentifier) {
        return;
      }

      let shouldTrigger = false;
      if (schedule.recurrence === "daily") {
        shouldTrigger = true;
      } else if (schedule.recurrence === "weekly") {
        if (currentDay === schedule.scheduledDay) {
          shouldTrigger = true;
        }
      } else if (schedule.recurrence === "days") {
        if (schedule.days.includes(currentDay)) {
          shouldTrigger = true;
        }
      }

      if (shouldTrigger) {
        const targetVisibility = schedule.action === "show";
        setSourceVisibility(schedule.source, targetVisibility);

        console.log(
          `Triggering schedule: ${schedule.action} ${schedule.source} at ${schedule.time
          } on ${daysMap[currentDay]} (Title: ${schedule.title || "N/A"})`
        );
        schedule.lastTriggered = currentDayTimeIdentifier;
        saveSchedules();
      }
    }
  });
}

function toggleScheduler() {
  schedulerEnabled = !schedulerEnabled;
  saveSchedulerState();
  updateSchedulerToggleButton();
  if (schedulerEnabled) {
    startScheduleChecker();
  } else {
    if (scheduleCheckInterval) {
      clearInterval(scheduleCheckInterval);
      scheduleCheckInterval = null;
    }
    // console.log("Scheduler stopped.");
  }
}

function updateSchedulerToggleButton() {
  const btn = document.getElementById("btnToggleScheduler");
  btn.className =
    "toggle-btn " + (schedulerEnabled ? "on-scheduler" : "off-scheduler");
  btn.textContent = "Scheduler: " + (schedulerEnabled ? "On" : "Off");
}

function loadSchedulerState() {
  const storedState = localStorage.getItem("schedulerEnabled");
  if (storedState !== null) {
    schedulerEnabled = storedState === "true";
  } else {
    schedulerEnabled = true;
  }
  updateSchedulerToggleButton();
}

function saveSchedulerState() {
  localStorage.setItem("schedulerEnabled", schedulerEnabled);
}

function toggleIndividualSchedule(id) {
  const scheduleIndex = schedules.findIndex((s) => s.id === id);
  if (scheduleIndex > -1) {
    schedules[scheduleIndex].enabled = !schedules[scheduleIndex].enabled;
    schedules[scheduleIndex].lastTriggered = null;
    saveSchedules();
    renderSchedules();
  }
}

async function copySchedulesToClipboard() {
  if (schedules.length === 0) {
    console.warn("No schedules to copy.");
    return;
  }
  const dataStr = JSON.stringify(schedules, null, 2);

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(dataStr)
      .then(() => {
        console.log(
          "Schedules data copied to clipboard! You can now paste it into a text file."
        );
      })
      .catch((err) => {
        console.error("Failed to copy using Clipboard API:", err);
      });
  } else {
    const tempTextArea = document.createElement("textarea");
    tempTextArea.value = dataStr;
    document.body.appendChild(tempTextArea);
    tempTextArea.select();
    try {
      const successful = document.execCommand("copy");
      if (successful) {
        console.log("Schedules data copied to clipboard!");
      } else {
        console.error("Failed to copy schedules data.");
      }
    } catch (err) {
      console.error("Copy command failed:", err);
    }
    document.body.removeChild(tempTextArea);
  }
}

function toggleImportArea() {
  if (importDataArea.style.display === "block") {
    importDataArea.style.display = "none";
    loadImportedDataBtn.style.display = "none";
    importDataArea.value = "";
  } else {
    importDataArea.style.display = "block";
    loadImportedDataBtn.style.display = "block";
    importDataArea.focus();
  }
}

async function loadSchedulesFromClipboard() {
  const pastedData = importDataArea.value.trim();
  if (!pastedData) {
    console.warn("Please paste schedule data into the text area first.");
    return;
  }

  try {
    const importedData = JSON.parse(pastedData);
    if (
      Array.isArray(importedData) &&
      importedData.every(
        (item) =>
          typeof item === "object" &&
          "time" in item &&
          "source" in item &&
          "action" in item
      )
    ) {
      schedules = importedData;
      schedules.forEach((schedule) => {
        if (typeof schedule.enabled === "undefined") {
          schedule.enabled = true;
        }
        if (typeof schedule.title === "undefined") {
          schedule.title = "";
        }
        if (typeof schedule.lastTriggered === "undefined") {
          schedule.lastTriggered = null;
        }
        if (typeof schedule.id === "undefined") {
          schedule.id = Date.now() + Math.random();
        }
      });
      saveSchedules();
      renderSchedules();
      console.log("Schedules imported successfully!");
      toggleImportArea();
    } else {
      console.error(
        "Invalid data format. Please ensure it's valid schedule JSON data."
      );
    }
  } catch (error) {
    console.error(
      "Error parsing pasted data. Please ensure it's valid JSON: " +
      error.message
    );
  }
}

// --- Event Listeners for Scheduler ---
if (addScheduleBtn) addScheduleBtn.addEventListener("click", addSchedule);
if (btnToggleScheduler)
  btnToggleScheduler.addEventListener("click", toggleScheduler);
if (document.getElementById("scheduleRecurrence"))
  document
    .getElementById("scheduleRecurrence")
    .addEventListener("change", toggleDaysOfWeek);
